import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Limits, WorkspaceMode } from '../config/config.js';
import { fromFsError, WorkspaceError } from '../errors/errors.js';
import { READ_FLAGS } from './file-reader.js';
import type { PathGuard } from './path-guard.js';
import { computeRevision } from './revision.js';

export interface WriteFileOptions extends Pick<Limits, 'maxWriteBytes'> {
  mode: WorkspaceMode;
}

export interface WriteFileParams {
  path: string;
  content: string;
  /** Required when the file exists; must be omitted to create a new file. */
  expectedRevision?: string;
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
      const current = await inspectExistingFile(absolutePath, relativePath);
      if (current.revision !== params.expectedRevision) {
        throw new WorkspaceError('REVISION_CONFLICT', `${relativePath} changed since it was read; read it again and retry`);
      }
      existingMode = current.mode;
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
      const handle = await open(tempPath, 'wx');
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
        await unlink(tempPath);
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

async function inspectExistingFile(absolutePath: string, relativePath: string): Promise<{ revision: string; mode: number }> {
  const handle = await open(absolutePath, READ_FLAGS).catch((error: unknown) => {
    throw fromFsError(error, relativePath);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkspaceError('NOT_A_FILE', `${relativePath} is not a regular file`);
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return { revision: `sha256:${hash.digest('hex')}`, mode: info.mode & 0o7777 };
  } finally {
    await handle.close();
  }
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
