import { stat } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { RE2JS, RE2JSException } from 're2js';

import { fromFsError, WorkspaceError } from '../errors/errors.js';
import { decodeTextFile, readRegularFile } from './file-reader.js';
import { compileGlob } from './glob.js';
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

/** Lists regular files whose path relative to `params.path` matches a glob (see compileGlob). */
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
  /** Literal text, or an RE2 regex when `regex` is true. */
  query: string;
  /** Optional glob, relative to `path`, that files must match. */
  glob?: string | undefined;
  caseSensitive: boolean;
  includeIgnored: boolean;
  limit: number;
  /** Interpret `query` as an RE2 regex (linear-time engine) instead of literal text. */
  regex: boolean;
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

/** Longest regex `search_text` compiles, like the glob limit. */
export const MAX_REGEX_LENGTH = 256;
/**
 * Largest compiled regex program (re2js `programSize`). Matching is linear in line length times
 * program size, so this bounds how long one line can block the event loop.
 */
export const MAX_REGEX_PROGRAM_SIZE = 100;
/** How long line matching runs before yielding so a timeout can abort the search. */
const YIELD_INTERVAL_MS = 20;

/**
 * Finds the first match of `query` on each line of the text files under `params.path`.
 * Files that read_file would reject (too large, binary, not UTF-8) or that cannot be read are
 * skipped. Neither mode backtracks: a literal query is escaped into a native regex only for case
 * folding, and a regex query runs on re2js, whose matching is linear in the input.
 */
export async function searchText(guard: PathGuard, options: SearchOptions, params: SearchTextParams): Promise<SearchTextResult> {
  const base = await resolveSearchBase(guard, params.path);
  const matchesGlob = params.glob === undefined ? () => true : globMatcher(base, params.glob);
  const findIn = params.regex ? regexMatcher(params.query, params.caseSensitive) : literalMatcher(params.query, params.caseSensitive);
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

    // Count lines like read_file: a final line break does not start another line.
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let yieldedAt = performance.now();
    for (let index = 0; index < lines.length; index++) {
      // Matching is synchronous; yield now and then so the request timeout can fire and abort.
      if (performance.now() - yieldedAt >= YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        options.signal?.throwIfAborted();
        yieldedAt = performance.now();
      }
      const line = (lines[index] as string).replace(/\r$/, '');
      const found = findIn(line);
      if (found < 0) continue;
      if (matches.length >= params.limit) {
        truncated = true;
        break search;
      }
      matches.push({ path: file.relativePath, line: index + 1, column: found + 1, text: matchText(line, found) });
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

/** Returns the UTF-16 index of the first match in `line`, or -1. */
type LineMatcher = (line: string) => number;

function literalMatcher(query: string, caseSensitive: boolean): LineMatcher {
  const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'u' : 'iu');
  return (line) => needle.exec(line)?.index ?? -1;
}

/** Compiles `pattern` with re2js (RE2 syntax: no backreferences or lookaround). */
function regexMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  if (pattern.length > MAX_REGEX_LENGTH) throw invalidRegex(`must be at most ${MAX_REGEX_LENGTH} characters`);
  let compiled: RE2JS;
  try {
    // Check syntax without flags first: re2js quotes the pattern in its message, prefixed with
    // `(?i)` under CASE_INSENSITIVE, and the client should only see what it sent.
    compiled = RE2JS.compile(pattern, 0);
    if (!caseSensitive) compiled = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  } catch (error) {
    if (error instanceof RE2JSException) throw invalidRegex(`is invalid: ${error.message}`);
    throw error;
  }
  if (compiled.programSize() > MAX_REGEX_PROGRAM_SIZE) {
    throw invalidRegex('is too complex; use fewer or smaller repetitions and alternatives');
  }
  return (line) => {
    // test() needs no match position, so re2js can answer it with its DFA; most lines do not match.
    if (!compiled.test(line)) return -1;
    const matcher = compiled.matcher(line);
    return matcher.find() ? matcher.start() : -1;
  };
}

function invalidRegex(reason: string): WorkspaceError {
  return new WorkspaceError('INVALID_PATH', `regex pattern ${reason}`);
}

function matchText(line: string, index: number): string {
  if (line.length <= MAX_MATCH_TEXT) return line;
  const start = Math.max(0, Math.min(index - MATCH_TEXT_LEAD, line.length - MAX_MATCH_TEXT));
  const end = start + MAX_MATCH_TEXT;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

async function resolveSearchBase(guard: PathGuard, input: string): Promise<ResolvedPath> {
  const base = await guard.resolveExisting(input);
  const info = await stat(base.absolutePath).catch((error: unknown) => {
    throw fromFsError(error, base.relativePath);
  });
  if (!info.isDirectory()) {
    throw new WorkspaceError('NOT_A_DIRECTORY', `${base.relativePath} is not a directory`);
  }
  return base;
}

/** Matches a glob against a walked file's path relative to the search base. */
function globMatcher(base: ResolvedPath, glob: string): (file: WalkedFile) => boolean {
  const matches = compileGlob(glob);
  const prefixLength = base.relativePath === '.' ? 0 : base.relativePath.length + 1;
  return (file) => matches(file.relativePath.slice(prefixLength));
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
