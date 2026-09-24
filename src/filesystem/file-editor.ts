import { WorkspaceError } from '../errors/errors.js';
import { decodeTextFile, readRegularFile } from './file-reader.js';
import { writeTextFile, type WriteFileOptions } from './file-writer.js';
import type { PathGuard } from './path-guard.js';
import { computeRevision } from './revision.js';

/** Upper bound on edits in one multi_edit_file call (M41). */
export const MAX_EDITS = 100;

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface EditFileParams extends TextEdit {
  path: string;
  expectedRevision: string;
}

export interface EditFileResult {
  path: string;
  replacements: number;
  bytes_written: number;
  revision: string;
}

export interface MultiEditFileParams {
  path: string;
  edits: TextEdit[];
  expectedRevision: string;
}

export interface MultiEditFileResult extends EditFileResult {
  edit_replacements: number[];
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
  const { path, replacements, bytes_written, revision } = await applyEditsToFile(
    guard,
    options,
    { path: params.path, edits: [params], expectedRevision: params.expectedRevision },
    false,
  );
  return { path, replacements, bytes_written, revision };
}

/**
 * Applies several exact-match edits to one file atomically (ADR-002 Amendment 2026-09-24).
 *
 * Edits run in order on the decoded content, so each `oldString` is matched against the
 * result of the earlier edits. Any failing edit leaves the file unchanged.
 */
export async function editTextFileMulti(
  guard: PathGuard,
  options: WriteFileOptions,
  params: MultiEditFileParams,
): Promise<MultiEditFileResult> {
  return applyEditsToFile(guard, options, params, true);
}

async function applyEditsToFile(
  guard: PathGuard,
  options: WriteFileOptions,
  params: MultiEditFileParams,
  labelEdits: boolean,
): Promise<MultiEditFileResult> {
  if (options.mode !== 'read-write') {
    throw new WorkspaceError('READ_ONLY', 'the workspace is read-only; the operator must enable read-write mode');
  }
  const { edits } = params;
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    throw new WorkspaceError('EDIT_NO_MATCH', `edits must contain between 1 and ${MAX_EDITS} edits`);
  }
  const label = (index: number) => (labelEdits ? `edits[${index}]: ` : '');
  edits.forEach((edit, index) => {
    if (edit.oldString.length === 0) {
      throw new WorkspaceError('EDIT_NO_MATCH', `${label(index)}old_string must not be empty`);
    }
  });

  const target = await guard.resolveForWrite(params.path);
  const { relativePath, absolutePath } = target;
  if (!target.exists) {
    throw new WorkspaceError('FILE_NOT_FOUND', `${relativePath} does not exist`);
  }
  edits.forEach((edit, index) => {
    // With well-formed content, a well-formed old_string can only match whole code points,
    // so no edit can split a surrogate pair, even one a later edit would rejoin.
    if (!edit.oldString.isWellFormed() || !edit.newString.isWellFormed()) {
      throw new WorkspaceError(
        'BINARY_FILE',
        `${label(index)}old_string and new_string must be well-formed Unicode text (no lone surrogates)`,
      );
    }
  });

  const { bytes } = await readRegularFile(absolutePath, relativePath, options.maxReadBytes);
  if (computeRevision(bytes) !== params.expectedRevision) {
    throw new WorkspaceError('REVISION_CONFLICT', `${relativePath} changed since it was read; read it again and retry`);
  }

  let content = decodeTextFile(bytes, relativePath);
  const counts: number[] = [];
  const earlier = (index: number) => (index > 0 ? ' after the earlier edits' : '');
  edits.forEach((edit, index) => {
    // split/join inserts newString literally; String.replace would expand `$&` and friends.
    const parts = content.split(edit.oldString);
    const replacements = parts.length - 1;
    if (replacements === 0) {
      throw new WorkspaceError(
        'EDIT_NO_MATCH',
        `${label(index)}old_string was not found in ${relativePath}${earlier(index)}; read the file again and copy the text exactly`,
      );
    }
    if (replacements > 1 && !edit.replaceAll) {
      throw new WorkspaceError(
        'EDIT_AMBIGUOUS',
        `${label(index)}old_string occurs ${replacements} times in ${relativePath}${earlier(index)}; include more surrounding text or set replace_all`,
      );
    }
    // UTF-8 needs at least one byte per UTF-16 code unit, so this bound never rejects a result
    // that fits, and it stops a replace_all from building a huge string before the size check.
    const minimumSize = content.length + replacements * (edit.newString.length - edit.oldString.length);
    if (minimumSize > options.maxWriteBytes) {
      throw new WorkspaceError(
        'FILE_TOO_LARGE',
        `${label(index)}the result would be at least ${minimumSize} bytes; the write limit is ${options.maxWriteBytes} bytes`,
      );
    }
    content = parts.join(edit.newString);
    counts.push(replacements);
    // writeTextFile checks the final size exactly; intermediate results are held to the limit too.
    if (index < edits.length - 1) {
      const size = Buffer.byteLength(content, 'utf8');
      if (size > options.maxWriteBytes) {
        throw new WorkspaceError(
          'FILE_TOO_LARGE',
          `${label(index)}the result is ${size} bytes; the write limit is ${options.maxWriteBytes} bytes`,
        );
      }
    }
  });

  const result = await writeTextFile(guard, options, {
    path: params.path,
    content,
    expectedRevision: params.expectedRevision,
    mustExist: true,
  });
  return {
    path: result.path,
    replacements: counts.reduce((sum, count) => sum + count, 0),
    edit_replacements: counts,
    bytes_written: result.bytes_written,
    revision: result.revision,
  };
}
