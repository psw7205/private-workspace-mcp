import { stat } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from '../errors/errors.js';
import type { PathGuard } from './path-guard.js';
import { walkFiles, type WalkStats } from './workspace-walker.js';

export interface SearchOptions {
  maxSearchFiles: number;
  /** Also bounds the ignore files a walk reads. */
  maxReadBytes: number;
  signal?: AbortSignal;
}

export interface FindFilesParams {
  /** Directory to search; `.` is the workspace root. */
  path: string;
  /** Glob matched against paths relative to `path`. */
  pattern: string;
  limit: number;
  /** Skip `.gitignore`/`.ignore` rules; the deny list still applies. */
  includeIgnored: boolean;
}

export interface FindFilesResult {
  path: string;
  pattern: string;
  files: Array<{ path: string; size: number }>;
  /** True when the result or scan limit cut the search short. */
  truncated: boolean;
  scan_limit_reached: boolean;
}

/**
 * Lists regular files whose path relative to `params.path` matches a glob. Matching uses
 * `path.posix.matchesGlob`: `*` stays within a segment, `**` spans segments, segments
 * starting with `.` match only when named, and case sensitivity follows the platform.
 */
export async function findFiles(guard: PathGuard, options: SearchOptions, params: FindFilesParams): Promise<FindFilesResult> {
  const base = await guard.resolveExisting(params.path);
  if (!(await stat(base.absolutePath)).isDirectory()) {
    throw new WorkspaceError('NOT_A_DIRECTORY', `${base.relativePath} is not a directory`);
  }

  const pattern = params.pattern.replace(/^(\.\/)+/, '');
  const prefixLength = base.relativePath === '.' ? 0 : base.relativePath.length + 1;
  const stats: WalkStats = { filesScanned: 0, scanLimitReached: false };
  const files: FindFilesResult['files'] = [];
  let truncated = false;

  const walk = walkFiles(
    guard,
    base,
    {
      maxFiles: options.maxSearchFiles,
      ignoreFiles: params.includeIgnored ? undefined : { maxBytes: options.maxReadBytes },
      signal: options.signal,
    },
    stats,
  );
  for await (const file of walk) {
    if (!path.posix.matchesGlob(file.relativePath.slice(prefixLength), pattern)) continue;
    if (files.length >= params.limit) {
      truncated = true;
      break;
    }
    files.push({ path: file.relativePath, size: file.size });
  }

  return {
    path: base.relativePath,
    pattern: params.pattern,
    files,
    truncated: truncated || stats.scanLimitReached,
    scan_limit_reached: stats.scanLimitReached,
  };
}
