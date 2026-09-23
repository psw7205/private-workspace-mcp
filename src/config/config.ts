import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_DENY_PATTERNS } from '../policy/deny-list.js';

export type WorkspaceMode = 'read-only' | 'read-write';

export interface Limits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxDirectoryEntries: number;
  maxDepth: number;
  requestTimeoutMs: number;
}

export interface AuditConfig {
  /** Canonical absolute JSONL file outside the workspace; stderr when absent. */
  path?: string;
  /** The file is rotated to `<path>.1` before it would exceed this size. */
  maxBytes: number;
}

export interface Config {
  /** Canonical absolute path. Never returned to MCP clients. */
  root: string;
  name: string;
  mode: WorkspaceMode;
  limits: Limits;
  audit: AuditConfig;
  /** Defaults followed by operator additions. */
  denyPatterns: string[];
}

const LIMIT_ENV: Record<keyof Limits, [name: string, fallback: number]> = {
  maxReadBytes: ['WORKSPACE_MAX_READ_BYTES', 1_048_576],
  maxWriteBytes: ['WORKSPACE_MAX_WRITE_BYTES', 1_048_576],
  maxDirectoryEntries: ['WORKSPACE_MAX_DIRECTORY_ENTRIES', 1000],
  maxDepth: ['WORKSPACE_MAX_DEPTH', 3],
  requestTimeoutMs: ['WORKSPACE_REQUEST_TIMEOUT_MS', 10_000],
};

/** Reads configuration from the environment and fails closed on any invalid value. */
export async function loadConfig(env: Record<string, string | undefined>): Promise<Config> {
  const rawRoot = env.WORKSPACE_ROOT;
  if (!rawRoot) throw new Error('WORKSPACE_ROOT is required');
  if (!path.isAbsolute(rawRoot)) throw new Error('WORKSPACE_ROOT must be an absolute path');

  const root = await realpath(rawRoot).catch(() => {
    throw new Error('WORKSPACE_ROOT does not exist or is not accessible');
  });
  if (!(await stat(root)).isDirectory()) throw new Error('WORKSPACE_ROOT must be a directory');

  const mode = env.WORKSPACE_MODE ?? 'read-only';
  if (mode !== 'read-only' && mode !== 'read-write') {
    throw new Error('WORKSPACE_MODE must be "read-only" or "read-write"');
  }

  const limits = {} as Limits;
  for (const [key, [name, fallback]] of Object.entries(LIMIT_ENV) as [keyof Limits, [string, number]][]) {
    limits[key] = parsePositiveInteger(name, env[name], fallback);
  }

  const audit: AuditConfig = {
    ...(env.WORKSPACE_AUDIT_LOG ? { path: await resolveAuditLogPath(env.WORKSPACE_AUDIT_LOG, root) } : {}),
    maxBytes: parsePositiveInteger('WORKSPACE_AUDIT_LOG_MAX_BYTES', env.WORKSPACE_AUDIT_LOG_MAX_BYTES, 10_485_760),
  };

  const denyPatterns = [...DEFAULT_DENY_PATTERNS, ...parseExtraDenyPatterns(env.WORKSPACE_EXTRA_DENY_PATTERNS)];

  return { root, name: env.WORKSPACE_NAME || path.basename(root), mode, limits, audit, denyPatterns };
}

/** The audit log must live outside the workspace so tools can neither read nor rewrite it. */
async function resolveAuditLogPath(raw: string, root: string): Promise<string> {
  if (!path.isAbsolute(raw)) throw new Error('WORKSPACE_AUDIT_LOG must be an absolute path');
  const parent = await realpath(path.dirname(raw)).catch(() => {
    throw new Error('WORKSPACE_AUDIT_LOG parent directory does not exist');
  });
  const file = path.join(parent, path.basename(raw));
  const relative = path.relative(root, file);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('WORKSPACE_AUDIT_LOG must be outside WORKSPACE_ROOT');
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

function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}
