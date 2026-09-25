import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from '../errors/errors.js';
import { relativeInside } from '../filesystem/path-guard.js';
import type { PathGuard } from '../filesystem/path-guard.js';
import type { DenyMatcher } from '../policy/deny-list.js';
import { assertGitSucceeded, canonicalNearestExistingSync, GIT_FAILED_MESSAGE, type GitResult, type GitRunner } from './runner.js';

/**
 * Cap for the server's own bookkeeping commands (config listing, rev-parse). They are not tool
 * output, so the read limit does not apply; a cut result fails closed (M59).
 */
export const INTERNAL_MAX_BYTES = 4 * 1024 * 1024;

const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/** Everything a Git operation needs about one workspace. */
export interface GitContext {
  runner: GitRunner;
  /** Canonical root of the selected workspace. */
  root: string;
  /** Canonical roots of every workspace; config must not pull files from any of them (§2.4.1). */
  roots: readonly string[];
  /** The workspace guard; checks `path` inputs, which may name deleted files (M66). */
  guard: PathGuard;
  /** In-process filter (ADR-004 §2.6 layer 2). */
  isDenied: DenyMatcher;
  /** Patterns for the static pathspec excludes (§2.6 layer 1). */
  denyPatterns: readonly string[];
  /** Cap for each child's stdout (`WORKSPACE_MAX_READ_BYTES`). */
  maxBytes: number;
}

const NOT_A_REPOSITORY_MESSAGE =
  'the workspace root is not a Git repository toplevel with its own .git directory (subdirectories, gitfiles, submodules, and linked worktrees are not supported)';
const UNSAFE_CONFIG_MESSAGE =
  'the repository configuration refers to files inside a workspace or defines config hooks, so the Git tools refuse to run';

/**
 * One tool call's git children: the boundary and config checks run first, then every later
 * command carries the filter overrides they produced and counts toward `bytesRead`.
 */
export class GitSession {
  bytesRead = 0;
  private filterArgs: string[] = [];
  /** `HEAD` until prepare() pins it to a tree OID (M53). */
  private attrSource = 'HEAD';

  constructor(
    readonly ctx: GitContext,
    readonly signal: AbortSignal,
  ) {}

  /**
   * ADR-004 §2.4 and §2.4.1, in that order, before any other git command. Then pins the
   * attributes source to HEAD's tree, or the empty tree before the first commit: git rejects
   * `--attr-source=HEAD` there, and the worktree `.gitattributes` must still not apply (M53).
   */
  async prepare(): Promise<void> {
    await this.assertRepository();
    const entries = parseConfigList((await this.runChecked(['config', '--list', '--show-origin', '--show-scope', '-z'])).stdout);
    this.filterArgs = await checkConfig(entries, this.ctx.root, this.ctx.roots);
    const head = await this.runInternal(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{tree}']);
    const tree = head.code === 0 && !head.truncated ? head.stdout.toString('utf8').trim() : '';
    this.attrSource = FULL_OID.test(tree) ? tree : await this.emptyTree();
  }

  /** The empty tree OID for this repository's object format; git knows it without storing it. */
  async emptyTree(): Promise<string> {
    const format = (await this.runChecked(['rev-parse', '--show-object-format'])).stdout.toString('utf8').trim();
    const tree = EMPTY_TREE[format];
    if (tree === undefined) throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, 'object-format');
    return tree;
  }

  /** A command whose stdout becomes tool output, cut at the read limit. */
  async run(args: readonly string[], maxBytes = this.ctx.maxBytes): Promise<GitResult> {
    const result = await this.ctx.runner.run(this.ctx.root, args, {
      signal: this.signal,
      maxBytes,
      config: this.filterArgs,
      attrSource: this.attrSource,
    });
    this.bytesRead += result.stdout.length;
    return result;
  }

  /** A bookkeeping command; its output is never returned as is. */
  runInternal(args: readonly string[]): Promise<GitResult> {
    return this.run(args, INTERNAL_MAX_BYTES);
  }

  /** A bookkeeping command that must succeed with its complete output. */
  async runChecked(args: readonly string[]): Promise<GitResult> {
    const result = await this.runInternal(args);
    assertGitSucceeded(result);
    if (result.truncated) throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, 'truncated');
    return result;
  }

  private async assertRepository(): Promise<void> {
    const { root } = this.ctx;
    const gitDir = path.join(root, '.git');
    // lstat, not stat: GIT_DIR would follow a gitfile or symlink, so git cannot make this call (§2.4-1).
    const info = await lstat(gitDir).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) throw new WorkspaceError('NOT_A_REPOSITORY', NOT_A_REPOSITORY_MESSAGE);
    const uid = process.getuid?.();
    if (process.platform !== 'win32' && uid !== undefined && !isOwnedBy(info.uid, uid)) {
      throw new WorkspaceError('NOT_A_REPOSITORY', NOT_A_REPOSITORY_MESSAGE, 'owner');
    }

    const result = await this.runInternal(['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
    const lines = result.stdout.toString('utf8').split('\n');
    if (result.truncated || result.code !== 0 || lines.length < 3) {
      throw new WorkspaceError('NOT_A_REPOSITORY', NOT_A_REPOSITORY_MESSAGE);
    }
    const expected = [gitDir, gitDir, root];
    for (const [index, line] of lines.slice(0, 3).entries()) {
      const actual = await realpath(path.resolve(root, line)).catch(() => undefined);
      if (actual === undefined || relativeInside(expected[index] as string, actual) !== '.') {
        throw new WorkspaceError('NOT_A_REPOSITORY', NOT_A_REPOSITORY_MESSAGE);
      }
    }
  }
}

/** POSIX ownership rule of §2.4-2, separate so it can be tested without a second uid. */
export function isOwnedBy(fileUid: number, processUid: number): boolean {
  return fileUid === processUid;
}

export interface ConfigEntry {
  scope: string;
  /** `file:<path>`, `command line:`, ... as printed by `--show-origin`. */
  origin: string;
  /** As git prints it: section and name lower case, subsection verbatim. */
  key: string;
  /** Undefined for a key without `=` (implicit true). */
  value: string | undefined;
}

/** Parses `git config --list --show-origin --show-scope -z`: `scope\0origin\0key[\nvalue]\0` per entry. */
export function parseConfigList(stdout: Buffer): ConfigEntry[] {
  const fields = stdout.toString('utf8').split('\0');
  const entries: ConfigEntry[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index] as string;
    const origin = fields[index + 1] as string;
    const pair = fields[index + 2] as string;
    const newline = pair.indexOf('\n');
    entries.push({
      scope,
      origin,
      key: newline === -1 ? pair : pair.slice(0, newline),
      value: newline === -1 ? undefined : pair.slice(newline + 1),
    });
  }
  return entries;
}

/** Keys whose value is a path git reads (ADR-004 §2.4.1). */
const PATH_KEYS = new Set([
  'core.attributesfile',
  'core.excludesfile',
  'mailmap.file',
  'blame.ignorerevsfile',
  'diff.orderfile',
  'commit.template',
  'core.hookspath',
]);

/**
 * The audit form of a config key: section and variable name only, the subsection replaced by `*`
 * (`includeif.*.path`, `hook.*.command`). Subsections can hold host paths or URL credentials,
 * which must not reach the audit log (invariant 6).
 */
export function keyClass(key: string): string {
  const lower = key.toLowerCase();
  const first = lower.indexOf('.');
  const last = lower.lastIndexOf('.');
  if (first === -1) return 'invalid';
  const section = lower.slice(0, first);
  const name = lower.slice(last + 1);
  const safe = (part: string) => (/^[a-z0-9-]{1,64}$/.test(part) ? part : 'invalid');
  return first === last ? `${safe(section)}.${safe(name)}` : `${safe(section)}.*.${safe(name)}`;
}

const INCLUDE_KEY = /^(include|includeif\..*)\.path$/s;
const FILTER_KEY = /^filter\.(.*)\.[^.]+$/s;
// `-c filter.<drv>.clean=` cannot express these characters in the driver name.
const UNEXPRESSIBLE_DRIVER = /[=\u0000-\u001f\u007f]/;

/**
 * Rejects config that pulls model-writable files into git (ADR-004 §2.4.1) and returns the `-c`
 * overrides that neutralize every filter driver the config defines (§2.3).
 */
export async function checkConfig(entries: readonly ConfigEntry[], root: string, roots: readonly string[]): Promise<string[]> {
  const gitDir = path.join(root, '.git');
  const unsafe = (detail: string) => new WorkspaceError('UNSAFE_GIT_CONFIG', UNSAFE_CONFIG_MESSAGE, detail);
  /**
   * True when the path, lexically or after symlinks, is inside a workspace but not inside this
   * repository's `.git` (M55). The lexical form matters because the model can retarget a link.
   */
  const reachesWorkspace = async (candidate: string): Promise<boolean> =>
    [path.resolve(candidate), canonicalNearestExistingSync(candidate)].some(
      (form) =>
        relativeInside(gitDir, form) === undefined &&
        roots.some((workspaceRoot) => relativeInside(workspaceRoot, form) !== undefined),
    );

  const drivers = new Set<string>();
  for (const entry of entries) {
    const detail = keyClass(entry.key);
    // The server's own `-c` arguments (M54).
    if (entry.scope === 'command') continue;
    if (!entry.origin.startsWith('file:')) throw unsafe(`origin:${entry.scope}`);
    const originFile = path.resolve(root, entry.origin.slice('file:'.length));
    if (await reachesWorkspace(originFile)) throw unsafe(detail);

    const key = entry.key;
    if (key.toLowerCase().startsWith('hook.')) throw unsafe(detail);

    const isInclude = INCLUDE_KEY.test(key.toLowerCase());
    if (isInclude || PATH_KEYS.has(key.toLowerCase())) {
      const value = entry.value;
      if (value === undefined || value.startsWith('~')) throw unsafe(detail);
      // Include paths are relative to the file they appear in; other path values to git's cwd,
      // the root. Both readings are checked for the non-include keys (M55).
      const candidates = isInclude
        ? [path.resolve(path.dirname(originFile), value)]
        : [path.resolve(path.dirname(originFile), value), path.resolve(root, value)];
      for (const candidate of candidates) {
        if (await reachesWorkspace(candidate)) throw unsafe(detail);
      }
    }

    const driver = FILTER_KEY.exec(key)?.[1];
    if (driver !== undefined && key.toLowerCase().startsWith('filter.')) {
      if (driver === '' || UNEXPRESSIBLE_DRIVER.test(driver)) throw unsafe('filter');
      drivers.add(driver);
    }
  }

  return [...drivers].flatMap((driver) =>
    [`filter.${driver}.clean=`, `filter.${driver}.smudge=`, `filter.${driver}.process=`, `filter.${driver}.required=false`].flatMap(
      (value) => ['-c', value],
    ),
  );
}

const SUFFIX = /(?:~[0-9]{1,4}|\^[0-9]?)*$/;
const HEX_OID = /^[0-9a-fA-F]{4,64}$/;
const REF_NAME = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Ref namespaces a revision may name (ADR-004 §2.5). `refs/stash`, notes, replace, original are not among them. */
const ALLOWED_REF_PREFIXES = ['refs/heads/', 'refs/tags/', 'refs/remotes/'];

/**
 * Validates `rev` (ADR-004 §2.5) and returns the full commit OID it names. Later commands only
 * ever receive that OID, so no user string reaches an option position.
 */
export async function resolveCommit(session: GitSession, rev: string, field: string): Promise<string> {
  const invalid = () =>
    new WorkspaceError(
      'INVALID_REVISION',
      `${field} must be HEAD, a commit id (4 to 64 hex digits), or a branch, tag, or remote-tracking branch name, optionally followed by ~N or ^N, and name an existing commit`,
    );
  const suffix = SUFFIX.exec(rev)?.[0] ?? '';
  const base = rev.slice(0, rev.length - suffix.length);
  if (base === '') throw invalid();
  if (base !== 'HEAD') {
    const hex = HEX_OID.test(base);
    if (!hex && !(REF_NAME.test(base) && !base.includes('..'))) throw invalid();
    const symbolic = await session.runInternal(['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options', base]);
    if (symbolic.truncated || symbolic.code !== 0) throw invalid();
    const fullName = symbolic.stdout.toString('utf8').trim();
    // Empty output means an object name, which only a hex base may be (M57).
    if (fullName === '' ? !hex : !ALLOWED_REF_PREFIXES.some((prefix) => fullName.startsWith(prefix))) throw invalid();
  }
  const resolved = await session.runInternal(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  const oid = resolved.stdout.toString('utf8').trim();
  if (resolved.truncated || resolved.code !== 0 || !FULL_OID.test(oid)) throw invalid();
  return oid;
}
