import { spawn, type ChildProcess } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from '../errors/errors.js';
import { relativeInside } from '../filesystem/path-guard.js';

/**
 * The null device as git expects it on every platform. Git for Windows maps exactly this string
 * to `nul` in `mingw_open`/`mingw_fopen`/`mingw_access` (compat/mingw.c), but rejects `os.devNull`
 * (`\\\\.\\nul`) as a config path with `unable to access ... Invalid argument` (M52).
 */
export const GIT_NULL_PATH = '/dev/null';

/** stderr is only kept for classification and never leaves the process (ADR-004 §2.7). */
export const GIT_STDERR_LIMIT = 64 * 1024;
/** git children running at once in this process; the rest wait inside the tool timeout (§2.7). */
export const GIT_MAX_CONCURRENT = 2;

/**
 * Arguments before every subcommand (ADR-004 §2.3). They switch off the execution paths that
 * repository config can otherwise select, independent of what that config says.
 */
export function gitGlobalArgs(attrSource = 'HEAD'): string[] {
  return [
    '--no-pager',
    '--no-optional-locks',
    `--attr-source=${attrSource}`,
    ...['core.fsmonitor=false', 'protocol.allow=never', 'color.ui=never', 'core.quotePath=false'].flatMap((value) => ['-c', value]),
    ...['diff.renames=false', 'status.renames=false', 'log.showSignature=false'].flatMap((value) => ['-c', value]),
    '-c',
    `core.hooksPath=${GIT_NULL_PATH}`,
    '-c',
    `core.attributesFile=${GIT_NULL_PATH}`,
  ];
}

/**
 * realpath of the deepest existing ancestor of `candidate`, joined with the missing rest. Uses the
 * native realpath like `loadConfig`: the JS one keeps Windows 8.3 short names (`RUNNER~1`), so a
 * short-name path inside a root would not compare equal to the canonical root (M55).
 */
export function canonicalNearestExistingSync(candidate: string): string {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `candidate` is inside one of `roots`, lexically or through symlinks. A missing
 * entry could be created later, so its nearest existing ancestor decides.
 */
function insideAnyRoot(candidate: string, roots: readonly string[]): boolean {
  const lexical = path.resolve(candidate);
  const canonical = canonicalNearestExistingSync(lexical);
  return roots.some((root) => relativeInside(root, lexical) !== undefined || relativeInside(root, canonical) !== undefined);
}

function readEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  // A plain object copy of the Windows environment keeps the original key case (`Path`).
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** `PATH` without relative entries or entries inside a workspace root (§2.3). */
export function hardenedPath(env: NodeJS.ProcessEnv, roots: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const entries = (readEnv(env, 'PATH', platform) ?? '').split(delimiter);
  return entries.filter((entry) => entry !== '' && flavor.isAbsolute(entry) && !insideAnyRoot(entry, roots)).join(delimiter);
}

/**
 * The complete environment of a git child, built from nothing (ADR-004 §2.3). Nothing else the
 * server inherited (`CONTROL_PLANE_API_KEY`, `GIT_*`, `SSH_*`, `HOME`, `XDG_CONFIG_HOME`) is passed.
 * `GIT_DIR` and `GIT_WORK_TREE` are added per call.
 */
export function buildGitEnv(
  env: NodeJS.ProcessEnv,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = { PATH: hardenedPath(env, roots, platform) };
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'windir']) {
      const value = readEnv(env, name, platform);
      if (value !== undefined) result[name] = value;
    }
  }
  return {
    ...result,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_PATH,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };
}

/**
 * Looks `git` up on the hardened `PATH` once and returns its canonical absolute path, so no
 * later lookup (Windows searches the cwd first) can pick a program from a workspace (§2.2).
 */
export async function findGit(
  pathValue: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const delimiter = platform === 'win32' ? ';' : ':';
  const name = platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '' || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (platform !== 'win32') await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if (insideAnyRoot(candidate, roots) || insideAnyRoot(canonical, roots)) continue;
      return canonical;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface GitInstallation {
  /** Canonical absolute path of the git executable. */
  path: string;
  /** Version reported by `git --version`, e.g. `2.54.0`. */
  version: string;
}

/**
 * Startup check for `WORKSPACE_GIT=read-only` (ADR-004 §2.2, §2.9): git must exist outside every
 * workspace and accept all of §2.3's global arguments. Unknown global options exit 129, so
 * running `--version` behind them proves support without comparing version strings.
 */
export async function detectGit(roots: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<GitInstallation> {
  const childEnv = buildGitEnv(env, roots);
  const found = await findGit(childEnv.PATH ?? '', roots);
  if (found === undefined) {
    throw new Error('WORKSPACE_GIT=read-only requires git on PATH outside every workspace root');
  }
  const gitPath = process.platform === 'win32' ? await windowsRealGit(found, childEnv, roots) : found;
  const { code, stdout } = await runOnce(gitPath, ['--version'], childEnv);
  const version = /^git version (\S+)/.exec(stdout)?.[1];
  if (code !== 0 || version === undefined) {
    throw new Error(
      'WORKSPACE_GIT=read-only requires a git that accepts the hardened arguments (--attr-source needs git 2.40 or later); git --version failed with them',
    );
  }
  return { path: gitPath, version };
}

/**
 * Git for Windows puts a launcher on PATH (`bin\git.exe`, `cmd\git.exe`) that starts
 * `mingw64\bin\git.exe` as a child; killing the launcher does not reach it, and Windows has no
 * process groups. So the server runs the real binary, found from `--exec-path`
 * (`<prefix>\libexec\git-core` → `<prefix>\bin\git.exe`), which runs builtins in process (M67).
 */
async function windowsRealGit(launcher: string, env: Record<string, string>, roots: readonly string[]): Promise<string> {
  const failure = () =>
    new Error('WORKSPACE_GIT=read-only on Windows requires Git for Windows (git --exec-path must lead to <prefix>\\bin\\git.exe)');
  const { code, stdout } = await runOnce(launcher, ['--exec-path'], env);
  const execPath = stdout.trim();
  if (code !== 0 || execPath === '' || !path.isAbsolute(execPath)) throw failure();
  const candidate = path.resolve(execPath, '..', '..', 'bin', 'git.exe');
  try {
    if (!(await stat(candidate)).isFile()) throw failure();
    const canonical = await realpath(candidate);
    if (insideAnyRoot(candidate, roots) || insideAnyRoot(canonical, roots)) throw failure();
    return canonical;
  } catch {
    throw failure();
  }
}

function runOnce(gitPath: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(gitPath, [...gitGlobalArgs(), ...args], {
      cwd: path.dirname(gitPath),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', () => resolve({ code: null, stdout: '' }));
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout: out }));
  });
}

export interface GitRunOptions {
  signal: AbortSignal;
  /** stdout beyond this many bytes ends the process group and sets `truncated`. */
  maxBytes: number;
  /** Extra `-c` arguments placed after the global ones, e.g. the filter overrides of §2.3. */
  config?: readonly string[];
  /** Tree whose `.gitattributes` apply; never the worktree (§2.3, M53). Default `HEAD`. */
  attrSource?: string;
}

export interface GitResult {
  stdout: Buffer;
  /** stdout reached `maxBytes`; the process was ended and `code` is meaningless. */
  truncated: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** At most GIT_STDERR_LIMIT bytes, for classification only. Never returned or audited. */
  stderr: string;
}

export interface GitRunnerOptions {
  /** Absolute path of the executable; tests substitute a fake. */
  gitPath: string;
  /** Every canonical workspace root, to harden `PATH`. */
  roots: readonly string[];
  /** The environment to derive the child environment from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  maxConcurrent?: number;
}

/** Spawns git without a shell under the hardened environment, one process group per child (ADR-004 §2.2, §2.7). */
export class GitRunner {
  readonly gitPath: string;
  private readonly env: Record<string, string>;
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly live = new Set<ChildProcess>();

  constructor(options: GitRunnerOptions) {
    this.gitPath = options.gitPath;
    this.env = buildGitEnv(options.env ?? process.env, options.roots);
    this.maxConcurrent = options.maxConcurrent ?? GIT_MAX_CONCURRENT;
  }

  /** Children currently alive; for tests. */
  get running(): number {
    return this.live.size;
  }

  async run(root: string, args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    await this.acquire(options.signal);
    try {
      return await this.spawnOnce(root, args, options);
    } finally {
      this.release();
    }
  }

  /** Ends every live git process group; called on server shutdown. Synchronous so it also works in an `exit` handler. */
  killAll(): void {
    for (const child of this.live) terminate(child);
  }

  private spawnOnce(root: string, args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const { signal, maxBytes } = options;
    signal.throwIfAborted();
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, [...gitGlobalArgs(options.attrSource), ...(options.config ?? []), ...args], {
        cwd: root,
        env: { ...this.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A new process group per child so a kill reaches whatever git started (POSIX).
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.live.add(child);

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let stderr = '';
      let stderrSize = 0;

      const onAbort = () => {
        terminate(child);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          terminate(child);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrSize >= GIT_STDERR_LIMIT) return;
        const part = chunk.subarray(0, GIT_STDERR_LIMIT - stderrSize);
        stderrSize += part.length;
        stderr += part.toString();
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        this.live.delete(child);
        signal.removeEventListener('abort', onAbort);
        reject(new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, `spawn:${error.code ?? 'unknown'}`));
      });
      child.on('close', (code, exitSignal) => {
        this.live.delete(child);
        signal.removeEventListener('abort', onAbort);
        resolve({ stdout: Buffer.concat(chunks, size), truncated, code, signal: exitSignal, stderr });
      });
    });
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes straight to the next waiter, so `active` stays the same.
    if (next) next();
    else this.active -= 1;
  }
}

export const GIT_FAILED_MESSAGE = 'git exited abnormally; the details are only in the server log';

/**
 * Kills the child's whole process group on POSIX; Windows has no groups (ADR-004 §2.10, M60).
 * Only called before the child's `close`, so a group member still holds its pipes even when the
 * leader has already exited.
 */
function terminate(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Throws GIT_FAILED for a non-zero exit that was not caused by the output cap (ADR-004 §2.8). */
export function assertGitSucceeded(result: GitResult): void {
  if (result.truncated || result.code === 0) return;
  const detail = result.code !== null ? `exit:${result.code}` : `signal:${result.signal ?? 'unknown'}`;
  throw new WorkspaceError('GIT_FAILED', GIT_FAILED_MESSAGE, detail);
}
