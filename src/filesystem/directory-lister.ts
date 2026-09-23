import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { fromFsError, WorkspaceError } from '../errors/errors.js';
import type { PathGuard } from './path-guard.js';

export interface DirectoryEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  /** Present for regular files only. */
  size?: number;
}

export interface ListDirectoryParams {
  path: string;
  /** 1 lists immediate children only. */
  depth: number;
  limit: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

/**
 * Depth-first, name-sorted listing. Symlinks are reported but never followed, so
 * traversal cannot leave the workspace or loop. Denied names and special files
 * (FIFOs, sockets, devices) are omitted.
 */
export async function listDirectory(guard: PathGuard, params: ListDirectoryParams): Promise<ListDirectoryResult> {
  const { relativePath, absolutePath } = await guard.resolveExisting(params.path);
  if (!(await stat(absolutePath)).isDirectory()) {
    throw new WorkspaceError('NOT_A_DIRECTORY', `${relativePath} is not a directory`);
  }

  const entries: DirectoryEntry[] = [];
  let truncated = false;

  const walk = async (directory: string, directoryRelative: string, level: number): Promise<void> => {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // An unreadable nested directory is listed but not descended into.
      if (level === 1) throw fromFsError(error, relativePath);
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      const childRelative = directoryRelative === '.' ? child.name : `${directoryRelative}/${child.name}`;
      const childAbsolute = path.join(directory, child.name);
      if (guard.isDenied(childRelative) || guard.isDenied(guard.assertInside(childAbsolute, childRelative))) continue;

      const type = child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : undefined;
      if (type === undefined) continue;

      if (entries.length >= params.limit) {
        truncated = true;
        return;
      }

      if (type === 'file') {
        const info = await lstat(childAbsolute).catch(() => undefined);
        if (info === undefined) continue;
        entries.push({ path: childRelative, type, size: info.size });
      } else {
        entries.push({ path: childRelative, type });
      }

      if (type === 'directory' && level < params.depth) {
        await walk(childAbsolute, childRelative, level + 1);
        if (truncated) return;
      }
    }
  };

  await walk(absolutePath, relativePath, 1);
  return { path: relativePath, entries, truncated };
}
