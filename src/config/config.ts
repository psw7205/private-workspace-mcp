import { lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { relativeInside } from '../filesystem/path-guard.js';
import { DEFAULT_DENY_PATTERNS } from '../policy/deny-list.js';

export type WorkspaceMode = 'read-only' | 'read-write';

export interface Limits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxDirectoryEntries: number;
  maxDepth: number;
  requestTimeoutMs: number;
  /** Regular files a find_files/search_text walk may visit. */
  maxSearchFiles: number;
}

export interface AuditConfig {
  /** Canonical absolute JSONL file outside the workspace; stderr when absent. */
  path?: string;
  /** The file is rotated to `<path>.1` before it would exceed this size. */
  maxBytes: number;
}

export interface Workspace {
  /** Returned to clients and, in multi mode, the value of the tools' `workspace` argument. */
  name: string;
  /** Canonical absolute path. Never returned to MCP clients. */
  root: string;
  /** Whether write tools may change this workspace; travels with the workspace so tools cannot pair it with another. */
  mode: WorkspaceMode;
}

export interface Config {
  /** At least one; roots never overlap. */
  workspaces: Workspace[];
  /** Set by WORKSPACE_ROOTS: tools take a `workspace` argument (ADR-008). */
  multi: boolean;
  limits: Limits;
  audit: AuditConfig;
  /** Defaults followed by operator additions. */
  denyPatterns: string[];
  /** Set by `WORKSPACE_GIT=read-only`: register the read-only Git tools (ADR-004 §2.9). */
  git: boolean;
}

// setTimeout clamps larger delays to 1 ms, which would time out every tool call.
const MAX_TIMER_MS = 2_147_483_647;

const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const LIMIT_ENV: Record<keyof Limits, [name: string, fallback: number, max?: number]> = {
  maxReadBytes: ['WORKSPACE_MAX_READ_BYTES', 1_048_576],
  maxWriteBytes: ['WORKSPACE_MAX_WRITE_BYTES', 1_048_576],
  maxDirectoryEntries: ['WORKSPACE_MAX_DIRECTORY_ENTRIES', 1000],
  maxDepth: ['WORKSPACE_MAX_DEPTH', 3],
  requestTimeoutMs: ['WORKSPACE_REQUEST_TIMEOUT_MS', 10_000, MAX_TIMER_MS],
  maxSearchFiles: ['WORKSPACE_MAX_SEARCH_FILES', 10_000],
};

/** Reads configuration from the environment and fails closed on any invalid value. */
export async function loadConfig(env: Record<string, string | undefined>): Promise<Config> {
  const multi = Boolean(env.WORKSPACE_ROOTS);
  const roots = env.WORKSPACE_ROOTS ? await loadWorkspaceRoots(env.WORKSPACE_ROOTS, env) : await loadWorkspaceRoot(env);

  const mode = env.WORKSPACE_MODE ?? 'read-only';
  if (mode !== 'read-only' && mode !== 'read-write') {
    throw new Error('WORKSPACE_MODE must be "read-only" or "read-write"');
  }
  const writable = parseReadWriteList(env, roots, multi);
  const workspaces: Workspace[] = roots.map((workspace) => ({
    ...workspace,
    mode: writable === undefined ? mode : writable.has(workspace.name) ? 'read-write' : 'read-only',
  }));

  const limits = {} as Limits;
  for (const [key, [name, fallback, max]] of Object.entries(LIMIT_ENV) as [keyof Limits, [string, number, number?]][]) {
    limits[key] = parsePositiveInteger(name, env[name], fallback, max);
  }

  const audit: AuditConfig = {
    ...(env.WORKSPACE_AUDIT_LOG ? { path: await resolveAuditLogPath(env.WORKSPACE_AUDIT_LOG, workspaces) } : {}),
    maxBytes: parsePositiveInteger('WORKSPACE_AUDIT_LOG_MAX_BYTES', env.WORKSPACE_AUDIT_LOG_MAX_BYTES, 10_485_760),
  };

  const denyPatterns = [...DEFAULT_DENY_PATTERNS, ...parseExtraDenyPatterns(env.WORKSPACE_EXTRA_DENY_PATTERNS)];

  // Only the one value turns Git on; any other non-empty value is a typo, not "off" (M52).
  const gitSetting = env.WORKSPACE_GIT ?? '';
  if (gitSetting !== '' && gitSetting !== 'read-only') throw new Error('WORKSPACE_GIT must be "read-only" or unset');

  return { workspaces, multi, limits, audit, denyPatterns, git: gitSetting === 'read-only' };
}

type WorkspaceRoot = Omit<Workspace, 'mode'>;

/**
 * Names from WORKSPACE_READ_WRITE, or undefined when unset so WORKSPACE_MODE applies to all.
 * Any ambiguity fails startup: single mode, WORKSPACE_MODE alongside, unknown or repeated names.
 */
function parseReadWriteList(
  env: Record<string, string | undefined>,
  roots: WorkspaceRoot[],
  multi: boolean,
): Set<string> | undefined {
  const raw = env.WORKSPACE_READ_WRITE;
  if (raw === undefined || raw === '') return undefined;
  if (!multi) throw new Error('WORKSPACE_READ_WRITE requires WORKSPACE_ROOTS; use WORKSPACE_MODE with WORKSPACE_ROOT');
  if (env.WORKSPACE_MODE !== undefined) {
    throw new Error('WORKSPACE_READ_WRITE cannot be combined with WORKSPACE_MODE; unlisted workspaces are read-only');
  }
  const names = new Set<string>();
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (!roots.some((workspace) => workspace.name === name)) {
      throw new Error('WORKSPACE_READ_WRITE entries must be workspace names from WORKSPACE_ROOTS');
    }
    if (names.has(name)) throw new Error(`WORKSPACE_READ_WRITE names workspace "${name}" twice`);
    names.add(name);
  }
  return names;
}

async function loadWorkspaceRoot(env: Record<string, string | undefined>): Promise<WorkspaceRoot[]> {
  if (!env.WORKSPACE_ROOT) throw new Error('WORKSPACE_ROOT is required');
  const root = await resolveRoot(env.WORKSPACE_ROOT, 'WORKSPACE_ROOT');
  return [{ name: env.WORKSPACE_NAME || path.basename(root), root }];
}

/** Parses `name=/abs/path,...`, splitting each entry at its first `=`. */
async function loadWorkspaceRoots(raw: string, env: Record<string, string | undefined>): Promise<WorkspaceRoot[]> {
  if (env.WORKSPACE_ROOT || env.WORKSPACE_NAME) {
    throw new Error('WORKSPACE_ROOTS cannot be combined with WORKSPACE_ROOT or WORKSPACE_NAME');
  }
  const workspaces: WorkspaceRoot[] = [];
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, Math.max(separator, 0)).trim();
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new Error('WORKSPACE_ROOTS entries must be name=/absolute/path with names of lowercase letters, digits, "-", or "_" (at most 64)');
    }
    if (workspaces.some((workspace) => workspace.name === name)) {
      throw new Error(`WORKSPACE_ROOTS names workspace "${name}" twice`);
    }
    const label = `WORKSPACE_ROOTS entry "${name}"`;
    workspaces.push({ name, root: await resolveRoot(entry.slice(separator + 1).trim(), label) });
  }

  // Overlapping roots would give one file two names and let workspace-specific checks disagree.
  for (const [index, a] of workspaces.entries()) {
    for (const b of workspaces.slice(index + 1)) {
      if (relativeInside(a.root, b.root) !== undefined || relativeInside(b.root, a.root) !== undefined) {
        throw new Error(`WORKSPACE_ROOTS entries "${a.name}" and "${b.name}" overlap`);
      }
    }
  }
  return workspaces;
}

/** Returns the canonical directory for `raw`; `label` names the setting in errors. */
async function resolveRoot(raw: string, label: string): Promise<string> {
  if (!path.isAbsolute(raw)) throw new Error(`${label} must be an absolute path`);
  const root = await realpath(raw).catch(() => {
    throw new Error(`${label} does not exist or is not accessible`);
  });
  if (!(await stat(root)).isDirectory()) throw new Error(`${label} must be a directory`);
  await assertNarrowRoot(root, label);
  return root;
}

/**
 * The root is the sandbox boundary, so refuse roots that expose the whole disk or the
 * home directory (`~/.ssh`, `~/.aws`, ...) instead of relying on the deny list.
 */
async function assertNarrowRoot(root: string, label: string): Promise<void> {
  const message = `${label} must not be the filesystem root, the home directory, or a parent of it`;
  if (path.parse(root).root === root) throw new Error(message);
  let home: string;
  try {
    // Throws when HOME is unset and the uid has no passwd entry, e.g. `docker run -u <uid>`.
    home = await realpath(os.homedir());
  } catch {
    return;
  }
  if (relativeInside(root, home) !== undefined) throw new Error(message);
}

/** The audit log must live outside every workspace so tools can neither read nor rewrite it. */
async function resolveAuditLogPath(raw: string, workspaces: WorkspaceRoot[]): Promise<string> {
  if (!path.isAbsolute(raw)) throw new Error('WORKSPACE_AUDIT_LOG must be an absolute path');
  const parent = await realpath(path.dirname(raw)).catch(() => {
    throw new Error('WORKSPACE_AUDIT_LOG parent directory does not exist');
  });
  const file = path.join(parent, path.basename(raw));
  if (workspaces.some(({ root }) => relativeInside(root, file) !== undefined)) {
    throw new Error('WORKSPACE_AUDIT_LOG must be outside every workspace root');
  }
  const info = await lstat(file).catch(() => undefined);
  if (info && !info.isFile()) throw new Error('WORKSPACE_AUDIT_LOG must be a regular file');
  return file;
}

/** Comma-separated path segment globs; malformed lists fail startup instead of being skipped. */
function parseExtraDenyPatterns(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((entry) => {
    const pattern = entry.trim();
    if (pattern === '' || /[/\\\u0000-\u001f\u007f]/.test(pattern)) {
      throw new Error('WORKSPACE_EXTRA_DENY_PATTERNS entries must be non-empty path segment globs without "/" or "\\"');
    }
    return pattern;
  });
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || value > max) throw new Error(`${name} must be a positive integer at most ${max}`);
  return value;
}
