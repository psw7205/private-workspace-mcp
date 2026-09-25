import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { fromFsError, WorkspaceError } from '../errors/errors.js';
import { isDenied as defaultIsDenied, type DenyMatcher } from '../policy/deny-list.js';

export const MAX_PATH_LENGTH = 4096;
// Rejected on every platform so a path means the same thing everywhere and
// Windows aliasing (`.env.`, `.env::$DATA`, `CON`) cannot bypass the deny list.
const FORBIDDEN_CHARACTERS = /[\\<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * Validates tool path syntax and returns it in canonical form: `/`-separated,
 * without empty or `.` segments, or `.` for the workspace root.
 */
export function normalizeRelativePath(input: string): string {
  if (input.length === 0) {
    throw new WorkspaceError('INVALID_PATH', 'path must not be empty; use "." for the workspace root');
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new WorkspaceError('INVALID_PATH', `path must be at most ${MAX_PATH_LENGTH} characters`);
  }
  if (input.startsWith('/') || input.startsWith('\\') || /^[a-zA-Z]:/.test(input)) {
    throw new WorkspaceError(
      'PATH_OUTSIDE_WORKSPACE',
      'absolute paths are not allowed; use a path relative to the workspace root',
    );
  }

  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new WorkspaceError('PATH_OUTSIDE_WORKSPACE', '".." segments are not allowed');
    }
    if (FORBIDDEN_CHARACTERS.test(segment)) {
      throw new WorkspaceError('INVALID_PATH', 'path contains a backslash, control character, or one of <>:"|?*');
    }
    if (/[. ]$/.test(segment)) {
      throw new WorkspaceError('INVALID_PATH', 'path segments must not end with "." or a space');
    }
    if (WINDOWS_RESERVED_NAME.test(segment.split('.')[0] ?? '')) {
      throw new WorkspaceError('INVALID_PATH', 'path contains a reserved device name');
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

/**
 * Returns canonical `candidate` relative to canonical `root` with `/` separators (`.` for
 * the root itself), or `undefined` when it is outside. The only containment test: it
 * compares `path.relative` output, never string prefixes.
 */
export function relativeInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

export interface ResolvedPath {
  /** Normalized path as requested by the client; safe to return. */
  relativePath: string;
  /** Canonical absolute path inside the workspace; never returned. */
  absolutePath: string;
}

export interface WriteTarget extends ResolvedPath {
  /** Canonical deepest existing parent directory. */
  existingAncestor: string;
  /** Parent directory names below `existingAncestor` that must be created. */
  missingDirectories: string[];
  exists: boolean;
}

/** The single gate between tool input and the filesystem (ADR-001 §10). */
export class PathGuard {
  /** @param root canonical absolute workspace root */
  constructor(
    private readonly root: string,
    readonly isDenied: DenyMatcher = defaultIsDenied,
  ) {}

  /** Resolves a path that must exist, following symlinks only while they stay inside. */
  async resolveExisting(input: string): Promise<ResolvedPath> {
    const relativePath = this.checkRelative(input);
    let absolutePath: string;
    try {
      absolutePath = await realpath(this.toAbsolute(relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await this.assertParentsAreDirectories(relativePath);
      throw fromFsError(error, relativePath);
    }
    this.assertAllowed(absolutePath, relativePath);
    return { relativePath, absolutePath };
  }

  /**
   * Resolves a file path to write. The target itself must not be a symlink; missing
   * parents are validated through the canonical nearest existing ancestor.
   */
  async resolveForWrite(input: string): Promise<WriteTarget> {
    const relativePath = this.checkRelative(input);
    if (relativePath === '.') {
      throw new WorkspaceError('NOT_A_FILE', 'the workspace root is a directory');
    }

    const parents = relativePath.split('/');
    const name = parents.pop() as string;

    let existingCount = parents.length;
    while (existingCount > 0) {
      try {
        await lstat(this.toAbsolute(parents.slice(0, existingCount).join('/')));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fromFsError(error, relativePath);
        existingCount--;
      }
    }

    const ancestorRelative = parents.slice(0, existingCount).join('/') || '.';
    let existingAncestor: string;
    try {
      existingAncestor = await realpath(this.toAbsolute(ancestorRelative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkspaceError('INVALID_PATH', `${ancestorRelative} is a broken symbolic link`);
      }
      throw fromFsError(error, relativePath);
    }
    this.assertInside(existingAncestor, relativePath);
    if (!(await stat(existingAncestor)).isDirectory()) {
      throw new WorkspaceError('NOT_A_DIRECTORY', `${ancestorRelative} is not a directory`);
    }

    const missingDirectories = parents.slice(existingCount);
    const absolutePath = path.join(existingAncestor, ...missingDirectories, name);
    this.assertAllowed(absolutePath, relativePath);

    let exists = false;
    if (missingDirectories.length === 0) {
      const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw fromFsError(error, relativePath);
      });
      if (info?.isSymbolicLink()) {
        throw new WorkspaceError('INVALID_PATH', `${relativePath} is a symbolic link; writing through links is not supported`);
      }
      if (info && !info.isFile()) {
        throw new WorkspaceError('NOT_A_FILE', `${relativePath} is not a regular file`);
      }
      exists = info !== undefined;
    }

    return { relativePath, absolutePath, existingAncestor, missingDirectories, exists };
  }

  /**
   * Validates a path that need not exist, such as a file in Git history (ADR-004 §2.5, M66): the
   * input and the canonical form of its deepest existing prefix must be inside and not denied.
   * Catches symlinks and Windows 8.3 aliases (`GIT~1` for `.git`) that the input check misses.
   * Returns the normalized relative path.
   */
  async checkMaybeMissing(input: string): Promise<string> {
    const relativePath = this.checkRelative(input);
    const segments = relativePath === '.' ? [] : relativePath.split('/');
    for (let count = segments.length; count >= 0; count--) {
      let ancestor: string;
      try {
        ancestor = await realpath(this.toAbsolute(segments.slice(0, count).join('/') || '.'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw fromFsError(error, relativePath);
      }
      this.assertAllowed(path.join(ancestor, ...segments.slice(count)), relativePath);
      return relativePath;
    }
    // Unreachable: the root itself resolves.
    throw new WorkspaceError('PATH_OUTSIDE_WORKSPACE', `${relativePath} resolves outside the workspace`);
  }

  /** Throws unless the canonical `absolutePath` is inside the workspace and not denied. */
  assertAllowed(absolutePath: string, relativePath: string): void {
    if (this.isDenied(this.assertInside(absolutePath, relativePath))) {
      throw new WorkspaceError('PATH_BLOCKED', `${relativePath} is blocked by the sensitive file policy`);
    }
  }

  /** Returns the workspace-relative form of a canonical path, or throws if it is outside. */
  assertInside(absolutePath: string, relativePath: string): string {
    const inside = relativeInside(this.root, absolutePath);
    if (inside === undefined) {
      throw new WorkspaceError('PATH_OUTSIDE_WORKSPACE', `${relativePath} resolves outside the workspace`);
    }
    return inside;
  }

  /**
   * Windows reports ENOENT where POSIX reports ENOTDIR for `file/child` (M28), so the
   * nearest existing parent decides between FILE_NOT_FOUND and NOT_A_DIRECTORY.
   */
  private async assertParentsAreDirectories(relativePath: string): Promise<void> {
    const parents = relativePath.split('/').slice(0, -1);
    for (let count = parents.length; count > 0; count--) {
      const info = await stat(this.toAbsolute(parents.slice(0, count).join('/'))).catch(() => undefined);
      if (info === undefined) continue;
      if (!info.isDirectory()) {
        throw new WorkspaceError('NOT_A_DIRECTORY', `a parent of ${relativePath} is not a directory`);
      }
      return;
    }
  }

  private checkRelative(input: string): string {
    const relativePath = normalizeRelativePath(input);
    if (this.isDenied(relativePath)) {
      throw new WorkspaceError('PATH_BLOCKED', `${relativePath} is blocked by the sensitive file policy`);
    }
    return relativePath;
  }

  private toAbsolute(relativePath: string): string {
    return path.join(this.root, ...relativePath.split('/'));
  }
}
