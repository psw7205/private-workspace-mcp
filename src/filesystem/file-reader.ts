import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { Limits } from '../config/config.js';
import { fromFsError, WorkspaceError } from '../errors/errors.js';
import type { PathGuard } from './path-guard.js';
import { computeRevision } from './revision.js';

export const DEFAULT_MAX_LINES = 2000;
const BINARY_SNIFF_BYTES = 8192;
// O_NOFOLLOW: refuse a final component swapped to a symlink after validation.
// O_NONBLOCK: opening a FIFO must not block before the regular-file check.
export const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface ReadFileParams {
  path: string;
  /** 1-based first line to return. */
  startLine?: number;
  maxLines?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  /** Size of the whole file in bytes. */
  size: number;
  total_lines: number;
  start_line: number;
  end_line: number;
  /** True when lines after `end_line` were not returned. */
  truncated: boolean;
  next_start_line?: number;
  /** Revision of the whole file, regardless of the returned window. */
  revision: string;
}

export async function readTextFile(
  guard: PathGuard,
  limits: Pick<Limits, 'maxReadBytes'>,
  params: ReadFileParams,
): Promise<ReadFileResult> {
  const { relativePath, absolutePath } = await guard.resolveExisting(params.path);
  const bytes = await readRegularFile(absolutePath, relativePath, limits.maxReadBytes);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new WorkspaceError('BINARY_FILE', `${relativePath} looks like a binary file; only text files can be read`);
  }

  // ignoreBOM keeps a leading BOM in the content so a read-modify-write round trip preserves it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const startLine = params.startLine ?? 1;
  const window = lines.slice(startLine - 1, startLine - 1 + (params.maxLines ?? DEFAULT_MAX_LINES));
  const endLine = startLine - 1 + window.length;
  const truncated = endLine < lines.length;

  return {
    path: relativePath,
    content: window.join(''),
    size: bytes.length,
    total_lines: lines.length,
    start_line: startLine,
    end_line: endLine,
    truncated,
    ...(truncated ? { next_start_line: endLine + 1 } : {}),
    revision: computeRevision(bytes),
  };
}

/** Reads a whole regular file, refusing anything larger than `maxBytes` even if it grows mid-read. */
export async function readRegularFile(absolutePath: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(absolutePath, READ_FLAGS).catch((error: unknown) => {
    throw fromFsError(error, relativePath);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkspaceError('NOT_A_FILE', `${relativePath} is not a regular file`);
    }
    if (info.size > maxBytes) {
      throw new WorkspaceError('FILE_TOO_LARGE', `${relativePath} is ${info.size} bytes; the read limit is ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new WorkspaceError('FILE_TOO_LARGE', `${relativePath} exceeds the read limit of ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
