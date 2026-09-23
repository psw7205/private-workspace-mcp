import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Limits, WorkspaceMode } from '../config/config.js';
import { fromFsError, WorkspaceError } from '../errors/errors.js';
import { readRegularFile } from './file-reader.js';
import type { PathGuard } from './path-guard.js';
import { computeRevision } from './revision.js';

export interface WriteFileOptions extends Pick<Limits, 'maxReadBytes' | 'maxWriteBytes'> {
  mode: WorkspaceMode;
}

export interface WriteFileParams {
  path: string;
  content: string;
  /** Required when the file exists; must be omitted to create a new file. */
  expectedRevision?: string;
  /** Report FILE_NOT_FOUND instead of offering to create a missing file (edit_file). */
  mustExist?: boolean;
}

export interface WriteFileResult {
  path: string;
  created: boolean;
  bytes_written: number;
  revision: string;
}

/** Serializes writes per canonical path so two agent requests cannot both pass the revision check. */
const pathLocks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (pathLocks.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  pathLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

/**
 * Creates or replaces a UTF-8 text file.
 *
 * Existing files are replaced via temp file + fsync + rename after the current
 * revision matches `expectedRevision`. New files are published with link(), which
 * fails if the path appeared in the meantime, so creation never overwrites.
 */
export async function writeTextFile(
  guard: PathGuard,
  options: WriteFileOptions,
  params: WriteFileParams,
): Promise<WriteFileResult> {
  if (options.mode !== 'read-write') {
    throw new WorkspaceError('READ_ONLY', 'the workspace is read-only; the operator must enable read-write mode');
  }
  // Buffer.from would silently encode a lone surrogate as U+FFFD.
  if (!params.content.isWellFormed()) {
    throw new WorkspaceError('BINARY_FILE', 'content is not well-formed Unicode text (it contains a lone surrogate)');
  }
  const bytes = Buffer.from(params.content, 'utf8');
  if (bytes.length > options.maxWriteBytes) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `content is ${bytes.length} bytes; the write limit is ${options.maxWriteBytes} bytes`,
    );
  }

  const { absolutePath: lockKey } = await guard.resolveForWrite(params.path);
  return withPathLock(lockKey, async () => {
    // Resolve again under the lock: a queued write may have changed the target.
    const target = await guard.resolveForWrite(params.path);
    const { relativePath, absolutePath } = target;

    let existingMode: number | undefined;
    if (target.exists) {
      if (params.expectedRevision === undefined) {
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          `${relativePath} already exists; read it and pass its revision as expected_revision to replace it`,
        );
      }
      // Bounded by the read limit: read_file never returns a revision for a larger file.
      const current = await readRegularFile(absolutePath, relativePath, options.maxReadBytes);
      if (computeRevision(current.bytes) !== params.expectedRevision) {
        throw new WorkspaceError('REVISION_CONFLICT', `${relativePath} changed since it was read; read it again and retry`);
      }
      existingMode = current.mode;
    } else if (params.mustExist) {
      throw new WorkspaceError('FILE_NOT_FOUND', `${relativePath} does not exist`);
    } else if (params.expectedRevision !== undefined) {
      throw new WorkspaceError(
        'REVISION_CONFLICT',
        `${relativePath} no longer exists; omit expected_revision to create it`,
      );
    }

    const parent = path.dirname(absolutePath);
    await createMissingDirectories(target.existingAncestor, target.missingDirectories, relativePath);
    if ((await realpath(parent)) !== parent) {
      throw new WorkspaceError('PATH_OUTSIDE_WORKSPACE', `a parent of ${relativePath} changed during the write`);
    }

    const tempPath = path.join(parent, `.pwmcp-${randomBytes(8).toString('hex')}.tmp`);
    try {
      // Create with the final mode so a private file's new content is never briefly more readable.
      const handle = await open(tempPath, 'wx', existingMode ?? 0o666);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      if (existingMode === undefined) {
        await link(tempPath, absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') {
            throw new WorkspaceError('REVISION_CONFLICT', `${relativePath} was created concurrently; read it and retry`);
          }
          throw error;
        });
        // The file is published; failing to drop the extra temp link must not fail the write.
        await unlink(tempPath).catch(() => undefined);
      } else {
        await chmod(tempPath, existingMode);
        await rename(tempPath, absolutePath);
      }
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw fromFsError(error, relativePath);
    }
    await syncDirectory(parent);

    return {
      path: relativePath,
      created: existingMode === undefined,
      bytes_written: bytes.length,
      revision: computeRevision(bytes),
    };
  });
}

async function createMissingDirectories(ancestor: string, names: string[], relativePath: string): Promise<void> {
  let directory = ancestor;
  for (const name of names) {
    directory = path.join(directory, name);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw fromFsError(error, relativePath);
    });
  }
}

/** Persists the rename in the directory entry where the platform supports it. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r').catch(() => undefined);
  if (handle === undefined) return;
  await handle.sync().catch(() => undefined);
  await handle.close();
}
