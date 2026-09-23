import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { fromFsError } from '../errors/errors.js';
import { decodeTextFile, readRegularFile } from './file-reader.js';
import type { PathGuard, ResolvedPath } from './path-guard.js';

export interface AllowedEntry {
  relativePath: string;
  absolutePath: string;
  type: 'file' | 'directory' | 'symlink';
}

/**
 * Sorts directory children by name and drops denied entries (checked on both the
 * workspace-relative and canonical path) and special files (FIFOs, sockets, devices).
 * `directory` must be canonical; children are never resolved, so symlinks stay symlinks.
 */
export function allowedEntries(
  guard: PathGuard,
  directory: string,
  directoryRelative: string,
  children: Dirent[],
): AllowedEntry[] {
  const entries: AllowedEntry[] = [];
  for (const child of [...children].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relativePath = directoryRelative === '.' ? child.name : `${directoryRelative}/${child.name}`;
    const absolutePath = path.join(directory, child.name);
    if (guard.isDenied(relativePath) || guard.isDenied(guard.assertInside(absolutePath, relativePath))) continue;
    const type = child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : undefined;
    if (type !== undefined) entries.push({ relativePath, absolutePath, type });
  }
  return entries;
}

export interface WalkOptions {
  /** Regular files to visit before stopping with `scanLimitReached`. Ignored files do not count. */
  maxFiles: number;
  /** Applies `.gitignore` and `.ignore` files (M23); omit to include ignored files. */
  ignoreFiles?: { maxBytes: number };
  signal?: AbortSignal;
}

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore'];

/** Rules from the ignore files of one directory; `base` is its canonical workspace-relative path. */
interface IgnoreScope {
  base: string;
  rules: Ignore;
}

/**
 * Loads a directory's ignore files. Each is read only as a regular file (lstat, since Windows
 * has no O_NOFOLLOW) that is not denied, within `maxBytes`, and as UTF-8; anything else counts
 * as absent, since ignore rules are a convenience and never a security boundary.
 */
async function loadIgnoreScope(
  guard: PathGuard,
  directory: string,
  directoryCanonical: string,
  maxBytes: number,
): Promise<IgnoreScope | undefined> {
  let rules: Ignore | undefined;
  for (const name of IGNORE_FILE_NAMES) {
    const relativePath = directoryCanonical === '.' ? name : `${directoryCanonical}/${name}`;
    if (guard.isDenied(relativePath)) continue;
    try {
      const file = path.join(directory, name);
      if (!(await lstat(file)).isFile()) continue;
      const { bytes } = await readRegularFile(file, relativePath, maxBytes);
      (rules ??= ignore()).add(decodeTextFile(bytes, relativePath));
    } catch {
      // Missing, symlinked, special, oversized, or not UTF-8: no rules from this file.
    }
  }
  return rules && { base: directoryCanonical, rules };
}

/** The deepest scope with a matching rule decides, so a nested `!pattern` re-includes a path. */
function isIgnored(scopes: IgnoreScope[], canonicalPath: string, isDirectory: boolean): boolean {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const { base, rules } = scopes[index] as IgnoreScope;
    const relative = base === '.' ? canonicalPath : canonicalPath.slice(base.length + 1);
    const result = rules.test(isDirectory ? `${relative}/` : relative);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

export interface WalkStats {
  filesScanned: number;
  scanLimitReached: boolean;
}

export interface WalkedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

/**
 * Yields the regular files below an existing directory, depth-first by name, with no
 * depth limit. Symlinks are never followed, so the walk cannot leave the workspace or
 * loop. An unreadable nested directory is skipped; an unreadable start directory throws.
 *
 * Ignore rules are matched on canonical workspace-relative paths, so ignore files above
 * `start` (including when `start` was reached through a symlink) apply as well.
 */
export async function* walkFiles(
  guard: PathGuard,
  start: ResolvedPath,
  options: WalkOptions,
  stats: WalkStats,
): AsyncGenerator<WalkedFile, void, undefined> {
  const startCanonical = guard.assertInside(start.absolutePath, start.relativePath);
  const ancestorScopes: IgnoreScope[] = [];
  if (options.ignoreFiles !== undefined && startCanonical !== '.') {
    const segments = startCanonical.split('/');
    const root = path.resolve(start.absolutePath, ...segments.map(() => '..'));
    for (let depth = 0; depth < segments.length; depth++) {
      const canonical = depth === 0 ? '.' : segments.slice(0, depth).join('/');
      const scope = await loadIgnoreScope(guard, path.join(root, ...segments.slice(0, depth)), canonical, options.ignoreFiles.maxBytes);
      if (scope !== undefined) ancestorScopes.push(scope);
    }
  }

  async function* walk(
    directory: string,
    directoryRelative: string,
    directoryCanonical: string,
    parentScopes: IgnoreScope[],
  ): AsyncGenerator<WalkedFile, boolean, undefined> {
    options.signal?.throwIfAborted();
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === start.absolutePath) throw fromFsError(error, start.relativePath);
      return true;
    }

    let scopes = parentScopes;
    if (options.ignoreFiles !== undefined) {
      const scope = await loadIgnoreScope(guard, directory, directoryCanonical, options.ignoreFiles.maxBytes);
      if (scope !== undefined) scopes = [...parentScopes, scope];
    }

    for (const entry of allowedEntries(guard, directory, directoryRelative, children)) {
      options.signal?.throwIfAborted();
      const name = path.posix.basename(entry.relativePath);
      const canonical = directoryCanonical === '.' ? name : `${directoryCanonical}/${name}`;
      if (entry.type !== 'symlink' && isIgnored(scopes, canonical, entry.type === 'directory')) continue;
      if (entry.type === 'directory') {
        if (!(yield* walk(entry.absolutePath, entry.relativePath, canonical, scopes))) return false;
      } else if (entry.type === 'file') {
        if (stats.filesScanned >= options.maxFiles) {
          stats.scanLimitReached = true;
          return false;
        }
        stats.filesScanned++;
        const info = await lstat(entry.absolutePath).catch(() => undefined);
        if (info?.isFile()) yield { relativePath: entry.relativePath, absolutePath: entry.absolutePath, size: info.size };
      }
    }
    return true;
  }

  yield* walk(start.absolutePath, start.relativePath, startCanonical, ancestorScopes);
}
