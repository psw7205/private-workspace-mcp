import { WorkspaceError } from '../errors/errors.js';
import { GitSession, resolveCommit, type GitContext } from './repository.js';
import { assertGitSucceeded, GIT_FAILED_MESSAGE, type GitResult } from './runner.js';

export interface GitOutcome<T> {
  result: T;
  bytesRead: number;
  truncated: boolean;
}

export const MAX_LOG_COUNT = 200;
export const DEFAULT_LOG_COUNT = 20;

const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];
const LOG_OPTIONS = ['--no-show-signature', '--no-use-mailmap', '--encoding=UTF-8'];
// Fixed by the server; no %G* (signature verification runs gpg.program).
const LOG_FORMAT = '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';
const LOG_FIELDS = 9;

/** `:(literal)` so glob characters and other magic in the path mean nothing (ADR-004 §2.5). */
function literalPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`;
}

/**
 * Static exclude pathspecs for the deny patterns (ADR-004 §2.6 layer 1). Deny patterns only
 * treat `*` specially, so `?` and `[` become one-character classes (`[?]`, `[[]`). A backslash
 * escape does not work on Windows, where git reads `\` in a pathspec as a directory separator
 * (M65). Extra deny patterns cannot contain `\` (config validation).
 */
export function denyExcludes(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => {
    const glob = pattern.replace(/[?[]/g, (special) => `[${special}]`);
    return [`:(exclude,icase,glob)**/${glob}`, `:(exclude,icase,glob)**/${glob}/**`];
  });
}

/**
 * Validates an optional `path` input like the filesystem tools do, without requiring it to exist:
 * syntax, deny on the input, and containment and deny on the canonical existing prefix (M66).
 */
async function checkPath(ctx: GitContext, input: string | undefined): Promise<string[]> {
  if (input === undefined) return [];
  const relativePath = await ctx.guard.checkMaybeMissing(input);
  return relativePath === '.' ? [] : [literalPathspec(relativePath)];
}

/** Complete NUL-terminated records of a `-z` output; a record cut by the output cap is dropped. */
function records(result: GitResult): string[] {
  const fields = result.stdout.toString('utf8').split('\0');
  fields.pop();
  return fields;
}

// ---------------------------------------------------------------------------------------------
// status

export interface StatusEntry {
  path: string;
  orig_path?: string;
  /** Index status letter from porcelain v2 (`.` unchanged, `?` untracked). */
  index: string;
  /** Worktree status letter from porcelain v2. */
  worktree: string;
}

export interface StatusResult {
  /** Current branch name, or null when HEAD is detached. */
  branch: string | null;
  /** HEAD commit, or null before the first commit. */
  oid: string | null;
  upstream: string | null;
  /** Whether HEAD and its upstream point at different commits; null without a reachable upstream. */
  upstream_differs: boolean | null;
  entries: StatusEntry[];
  truncated: boolean;
}

interface RawStatus extends StatusResult {
  /** Every entry git reported, including denied ones (for the diff layer-2 excludes). */
  all: StatusEntry[];
}

async function readStatus(session: GitSession, pathspecs: string[]): Promise<RawStatus> {
  const { ctx } = session;
  const result = await session.run([
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--no-ahead-behind',
    '--untracked-files=all',
    '--ignore-submodules=all',
    '--',
    ...pathspecs,
    ...denyExcludes(ctx.denyPatterns),
  ]);
  assertGitSucceeded(result);
  const status: RawStatus = { branch: null, oid: null, upstream: null, upstream_differs: null, entries: [], all: [], truncated: result.truncated };
  const fields = records(result);
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index] as string;
    if (record.startsWith('# ')) {
      const [name, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (name === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (name === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (name === 'branch.upstream') status.upstream = value;
      else if (name === 'branch.ab') status.upstream_differs = value !== '+0 -0';
      continue;
    }
    let entry: StatusEntry | undefined;
    const type = record[0];
    if (type === '1' || type === 'u') {
      // `1 XY sub mH mI mW hH hI path`, `u XY sub m1 m2 m3 mW h1 h2 h3 path`
      const parts = record.split(' ');
      const path = parts.slice(type === '1' ? 8 : 10).join(' ');
      entry = { path, index: record[2] as string, worktree: record[3] as string };
    } else if (type === '2') {
      // `2 XY sub mH mI mW hH hI Xscore path` then the original path as its own record.
      const parts = record.split(' ');
      const orig = fields[index + 1];
      index += 1;
      if (orig === undefined) break;
      entry = { path: parts.slice(9).join(' '), orig_path: orig, index: record[2] as string, worktree: record[3] as string };
    } else if (type === '?') {
      entry = { path: record.slice(2), index: '?', worktree: '?' };
    }
    if (entry === undefined) continue;
    status.all.push(entry);
    if (ctx.isDenied(entry.path) || (entry.orig_path !== undefined && ctx.isDenied(entry.orig_path))) continue;
    status.entries.push(entry);
  }
  // Without `branch.ab` the upstream is gone or absent.
  if (status.upstream === null) status.upstream_differs = null;
  return status;
}

export async function gitStatus(ctx: GitContext, signal: AbortSignal): Promise<GitOutcome<StatusResult>> {
  const session = new GitSession(ctx, signal);
  await session.prepare();
  const { all: _all, ...result } = await readStatus(session, []);
  return { result, bytesRead: session.bytesRead, truncated: result.truncated };
}

// ---------------------------------------------------------------------------------------------
// diff

export interface DiffFile {
  path: string;
  orig_path?: string;
  /** `A`, `D`, `M`, `T`, `U`, ... */
  status: string;
}

export interface DiffResult {
  files: DiffFile[];
  /** Unified patch without denied files. Cut at the last complete file section when truncated. */
  patch: string;
  truncated: boolean;
}

/** `diff-tree --name-status -z` records: status, path, and a second path for R/C. */
function parseNameStatus(fields: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] as string;
    if (/^[RC]/.test(status)) {
      const orig = fields[index + 1];
      const target = fields[index + 2];
      index += 3;
      if (orig === undefined || target === undefined) break;
      files.push({ path: target, orig_path: orig, status: status[0] as string });
    } else {
      const target = fields[index + 1];
      index += 2;
      if (target === undefined) break;
      files.push({ path: target, status });
    }
  }
  return files;
}

/** Drops the last, possibly incomplete file section of a cut patch (ADR-004 §2.7). */
function completePatch(result: GitResult): string {
  const text = result.stdout.toString('utf8');
  if (!result.truncated) return text;
  const cut = text.lastIndexOf('\ndiff --git ');
  return cut === -1 ? '' : text.slice(0, cut + 1);
}

function deniedExcludes(ctx: GitContext, files: readonly { path: string; orig_path?: string }[]): string[] {
  const denied = new Set<string>();
  for (const file of files) {
    for (const candidate of [file.path, file.orig_path]) {
      if (candidate !== undefined && ctx.isDenied(candidate)) denied.add(candidate);
    }
  }
  return [...denied].map((candidate) => `:(exclude,literal)${candidate}`);
}

/**
 * Lists the changed files, filters them in process, then produces the patch with the denied ones
 * excluded as well (ADR-004 §2.6 layer 2). A cut listing yields no patch (M58).
 */
async function listedDiff(
  session: GitSession,
  all: DiffFile[],
  listingTruncated: boolean,
  patchArgs: string[],
  pathspecs: string[],
): Promise<DiffResult> {
  const { ctx } = session;
  const files = all.filter((file) => !ctx.isDenied(file.path) && (file.orig_path === undefined || !ctx.isDenied(file.orig_path)));
  if (listingTruncated) return { files, patch: '', truncated: true };
  if (files.length === 0) return { files, patch: '', truncated: false };
  const result = await session.run([...patchArgs, '--', ...pathspecs, ...denyExcludes(ctx.denyPatterns), ...deniedExcludes(ctx, all)]);
  assertGitSucceeded(result);
  return { files, patch: completePatch(result), truncated: result.truncated };
}

async function treeDiff(session: GitSession, trees: string[], pathspecs: string[]): Promise<DiffResult> {
  const listing = await session.run([
    'diff-tree',
    '-r',
    '--no-commit-id',
    '--name-status',
    '-z',
    ...DIFF_OPTIONS,
    ...trees,
    '--',
    ...pathspecs,
    ...denyExcludes(session.ctx.denyPatterns),
  ]);
  assertGitSucceeded(listing);
  const all = parseNameStatus(records(listing));
  return listedDiff(session, all, listing.truncated, ['diff-tree', '-r', '--no-commit-id', '-p', ...DIFF_OPTIONS, ...trees], pathspecs);
}

export interface DiffInput {
  base?: string;
  head?: string;
  staged?: boolean;
  path?: string;
}

export async function gitDiff(ctx: GitContext, input: DiffInput, signal: AbortSignal): Promise<GitOutcome<DiffResult>> {
  if (input.head !== undefined && input.base === undefined) {
    throw new WorkspaceError('INVALID_REVISION', 'head requires base; omit both to compare the worktree with the index');
  }
  if (input.staged && input.base !== undefined) {
    throw new WorkspaceError('INVALID_REVISION', 'staged compares the index with HEAD and cannot be combined with base or head');
  }
  const pathspecs = await checkPath(ctx, input.path);
  const session = new GitSession(ctx, signal);
  await session.prepare();

  let result: DiffResult;
  if (input.base !== undefined) {
    const base = await resolveCommit(session, input.base, 'base');
    const head = await resolveCommit(session, input.head ?? 'HEAD', 'head');
    result = await treeDiff(session, [base, head], pathspecs);
  } else {
    // The status entries are the listing: `diff-files --name-status` also reports stat-only changes (§2.6).
    const status = await readStatus(session, pathspecs);
    const column = input.staged ? 'index' : 'worktree';
    const all = status.all
      .filter((entry) => entry.index !== '?' && entry[column] !== '.')
      .map((entry) => ({ path: entry.path, ...(entry.orig_path !== undefined ? { orig_path: entry.orig_path } : {}), status: entry[column] }));
    let patchArgs: string[];
    if (input.staged) {
      const tree = status.oid ?? (await session.emptyTree());
      patchArgs = ['diff-index', '--cached', '-p', ...DIFF_OPTIONS, tree];
    } else {
      patchArgs = ['diff-files', '-p', ...DIFF_OPTIONS];
    }
    result = await listedDiff(session, all, status.truncated, patchArgs, pathspecs);
  }
  return { result, bytesRead: session.bytesRead, truncated: result.truncated };
}

// ---------------------------------------------------------------------------------------------
// log and show

export interface Person {
  name: string;
  email: string;
  /** Strict ISO 8601 with the recorded offset. */
  date: string;
}

export interface Commit {
  oid: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

function parseCommits(result: GitResult): Commit[] {
  const fields = result.stdout.toString('utf8').split('\0');
  const commits: Commit[] = [];
  // Each commit ends with a NUL, so a complete one is followed by at least one more field (the
  // empty rest after the final NUL). A commit cut by the output cap is not, and is dropped.
  for (let index = 0; index + LOG_FIELDS < fields.length; index += LOG_FIELDS) {
    const [oid, parents, an, ae, ad, cn, ce, cd, message] = fields.slice(index, index + LOG_FIELDS) as string[] as [
      string, string, string, string, string, string, string, string, string,
    ];
    // Misaligned fields (a NUL inside a message) are an error rather than a guess.
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, 'log-format');
    commits.push({
      oid,
      parents: parents === '' ? [] : parents.split(' '),
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
      message: message.endsWith('\n') ? message.slice(0, -1) : message,
    });
  }
  return commits;
}

export interface LogInput {
  rev?: string;
  path?: string;
  max_count?: number;
}

export interface LogResult {
  commits: Commit[];
  truncated: boolean;
}

export async function gitLog(ctx: GitContext, input: LogInput, signal: AbortSignal): Promise<GitOutcome<LogResult>> {
  const pathspecs = await checkPath(ctx, input.path);
  const count = input.max_count ?? DEFAULT_LOG_COUNT;
  const session = new GitSession(ctx, signal);
  await session.prepare();
  const oid = await resolveCommit(session, input.rev ?? 'HEAD', 'rev');
  // No static excludes: a log pathspec changes which commits are selected, not what is printed (§2.6).
  const result = await session.run(['log', '-n', String(count), ...LOG_OPTIONS, '-z', LOG_FORMAT, oid, '--', ...pathspecs]);
  assertGitSucceeded(result);
  const commits = parseCommits(result);
  return { result: { commits, truncated: result.truncated }, bytesRead: session.bytesRead, truncated: result.truncated };
}

export interface ShowResult extends DiffResult {
  commit: Commit;
}

export async function gitShow(ctx: GitContext, input: { rev: string }, signal: AbortSignal): Promise<GitOutcome<ShowResult>> {
  const session = new GitSession(ctx, signal);
  await session.prepare();
  const oid = await resolveCommit(session, input.rev, 'rev');
  // Metadata without a pathspec: `git show <oid> -- <exclude>` drops the whole commit when it only touched denied files.
  const meta = await session.run(['log', '-1', '--no-walk', ...LOG_OPTIONS, '-z', LOG_FORMAT, oid]);
  assertGitSucceeded(meta);
  // A message over the read limit cannot be shown in part without a partial commit record (M59).
  if (meta.truncated) throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, 'truncated');
  const commit = parseCommits(meta)[0];
  if (commit === undefined) throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, 'log-format');
  const parent = commit.parents[0];
  const diff = await treeDiff(session, parent === undefined ? ['--root', oid] : [parent, oid], []);
  return { result: { commit, ...diff }, bytesRead: session.bytesRead, truncated: diff.truncated };
}
