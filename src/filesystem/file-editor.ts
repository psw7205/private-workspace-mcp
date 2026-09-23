import { WorkspaceError } from '../errors/errors.js';
import { decodeTextFile, readRegularFile } from './file-reader.js';
import { writeTextFile, type WriteFileOptions } from './file-writer.js';
import type { PathGuard } from './path-guard.js';
import { computeRevision } from './revision.js';

export interface EditFileParams {
  path: string;
  oldString: string;
  newString: string;
  expectedRevision: string;
  replaceAll: boolean;
}

export interface EditFileResult {
  path: string;
  replacements: number;
  bytes_written: number;
  revision: string;
}

/**
 * Replaces exact occurrences of `oldString` in an existing UTF-8 text file (ADR-002).
 *
 * The file is read under the same rules as read_file, and the result is written through
 * writeTextFile, which re-checks `expectedRevision` under its path lock before replacing.
 */
export async function editTextFile(
  guard: PathGuard,
  options: WriteFileOptions,
  params: EditFileParams,
): Promise<EditFileResult> {
  if (options.mode !== 'read-write') {
    throw new WorkspaceError('READ_ONLY', 'the workspace is read-only; the operator must enable read-write mode');
  }
  if (params.oldString.length === 0) {
    throw new WorkspaceError('EDIT_NO_MATCH', 'old_string must not be empty');
  }

  const target = await guard.resolveForWrite(params.path);
  const { relativePath, absolutePath } = target;
  if (!target.exists) {
    throw new WorkspaceError('FILE_NOT_FOUND', `${relativePath} does not exist`);
  }

  const { bytes } = await readRegularFile(absolutePath, relativePath, options.maxReadBytes);
  if (computeRevision(bytes) !== params.expectedRevision) {
    throw new WorkspaceError('REVISION_CONFLICT', `${relativePath} changed since it was read; read it again and retry`);
  }

  // split/join inserts newString literally; String.replace would expand `$&` and friends.
  const parts = decodeTextFile(bytes, relativePath).split(params.oldString);
  const replacements = parts.length - 1;
  if (replacements === 0) {
    throw new WorkspaceError(
      'EDIT_NO_MATCH',
      `old_string was not found in ${relativePath}; read the file again and copy the text exactly`,
    );
  }
  if (replacements > 1 && !params.replaceAll) {
    throw new WorkspaceError(
      'EDIT_AMBIGUOUS',
      `old_string occurs ${replacements} times in ${relativePath}; include more surrounding text or set replace_all`,
    );
  }

  const result = await writeTextFile(guard, options, {
    path: params.path,
    content: parts.join(params.newString),
    expectedRevision: params.expectedRevision,
    mustExist: true,
  });
  return { path: result.path, replacements, bytes_written: result.bytes_written, revision: result.revision };
}
