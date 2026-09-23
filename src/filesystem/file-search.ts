import { stat } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from '../errors/errors.js';
import { decodeTextFile, readRegularFile } from './file-reader.js';
import type { PathGuard, ResolvedPath } from './path-guard.js';
import { walkFiles, type WalkedFile, type WalkStats } from './workspace-walker.js';

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
  const base = await resolveSearchBase(guard, params.path);
  const matches = globMatcher(base, params.pattern);
  const stats: WalkStats = { filesScanned: 0, scanLimitReached: false };
  const files: FindFilesResult['files'] = [];
  let truncated = false;

  for await (const file of searchWalk(guard, base, options, params.includeIgnored, stats)) {
    if (!matches(file)) continue;
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

export interface SearchTextParams {
  /** Directory to search; `.` is the workspace root. */
  path: string;
  /** Literal text; never interpreted as a pattern. */
  query: string;
  /** Optional glob, relative to `path`, that files must match. */
  glob?: string | undefined;
  caseSensitive: boolean;
  includeIgnored: boolean;
  limit: number;
}

export interface TextMatch {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
  /** The line without its line break, cut to a window around the match when long. */
  text: string;
}

export interface SearchTextResult {
  path: string;
  query: string;
  matches: TextMatch[];
  files_searched: number;
  truncated: boolean;
  scan_limit_reached: boolean;
  /** Bytes read from searched files, for the audit record only. */
  bytesRead: number;
}

const MAX_MATCH_TEXT = 200;
const MATCH_TEXT_LEAD = 60;

/**
 * Finds the first occurrence of `query` on each line of the text files under `params.path`.
 * Files that read_file would reject (too large, binary, not UTF-8) or that cannot be read are
 * skipped. The query is escaped into a literal regex only for case folding, so matching is
 * linear and cannot backtrack.
 */
export async function searchText(guard: PathGuard, options: SearchOptions, params: SearchTextParams): Promise<SearchTextResult> {
  const base = await resolveSearchBase(guard, params.path);
  const matchesGlob = params.glob === undefined ? () => true : globMatcher(base, params.glob);
  const needle = new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), params.caseSensitive ? 'u' : 'iu');
  const stats: WalkStats = { filesScanned: 0, scanLimitReached: false };
  const matches: TextMatch[] = [];
  let filesSearched = 0;
  let bytesRead = 0;
  let truncated = false;

  search: for await (const file of searchWalk(guard, base, options, params.includeIgnored, stats)) {
    if (file.size > options.maxReadBytes || !matchesGlob(file)) continue;
    let text: string;
    try {
      const { bytes } = await readRegularFile(file.absolutePath, file.relativePath, options.maxReadBytes);
      bytesRead += bytes.length;
      text = decodeTextFile(bytes, file.relativePath);
    } catch {
      continue;
    }
    filesSearched++;

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = (lines[index] as string).replace(/\r$/, '');
      const found = needle.exec(line);
      if (found === null) continue;
      if (matches.length >= params.limit) {
        truncated = true;
        break search;
      }
      matches.push({ path: file.relativePath, line: index + 1, column: found.index + 1, text: matchText(line, found.index) });
    }
  }

  return {
    path: base.relativePath,
    query: params.query,
    matches,
    files_searched: filesSearched,
    truncated: truncated || stats.scanLimitReached,
    scan_limit_reached: stats.scanLimitReached,
    bytesRead,
  };
}

function matchText(line: string, index: number): string {
  if (line.length <= MAX_MATCH_TEXT) return line;
  const start = Math.max(0, Math.min(index - MATCH_TEXT_LEAD, line.length - MAX_MATCH_TEXT));
  const end = start + MAX_MATCH_TEXT;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

async function resolveSearchBase(guard: PathGuard, input: string): Promise<ResolvedPath> {
  const base = await guard.resolveExisting(input);
  if (!(await stat(base.absolutePath)).isDirectory()) {
    throw new WorkspaceError('NOT_A_DIRECTORY', `${base.relativePath} is not a directory`);
  }
  return base;
}

/** Matches a glob against a walked file's path relative to the search base; a leading `./` is dropped. */
function globMatcher(base: ResolvedPath, glob: string): (file: WalkedFile) => boolean {
  const pattern = glob.replace(/^(\.\/)+/, '');
  const prefixLength = base.relativePath === '.' ? 0 : base.relativePath.length + 1;
  return (file) => path.posix.matchesGlob(file.relativePath.slice(prefixLength), pattern);
}

function searchWalk(
  guard: PathGuard,
  base: ResolvedPath,
  options: SearchOptions,
  includeIgnored: boolean,
  stats: WalkStats,
): AsyncGenerator<WalkedFile, void, undefined> {
  return walkFiles(
    guard,
    base,
    {
      maxFiles: options.maxSearchFiles,
      ignoreFiles: includeIgnored ? undefined : { maxBytes: options.maxReadBytes },
      signal: options.signal,
    },
    stats,
  );
}
