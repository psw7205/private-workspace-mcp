export type ErrorCode =
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_BLOCKED'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'READ_ONLY'
  | 'REVISION_CONFLICT'
  | 'EDIT_NO_MATCH'
  | 'EDIT_AMBIGUOUS'
  | 'INVALID_PATH'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'NOT_A_REPOSITORY'
  | 'UNSAFE_GIT_CONFIG'
  | 'INVALID_REVISION'
  | 'GIT_FAILED'
  | 'INTERNAL_ERROR';

/**
 * An error the agent can act on. `message` is returned to the MCP client verbatim,
 * so it must only reference workspace-relative paths.
 */
export class WorkspaceError extends Error {
  /**
   * @param detail audit-only `error_detail` (e.g. `exit:128`, a config key name). Never sent to the
   *   client and must not contain content, secrets, or host paths.
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * Maps a Node.js filesystem error to a WorkspaceError for `relativePath`.
 * Node error messages embed absolute paths, so they are never forwarded; an
 * unrecognized error is rethrown unchanged and surfaces as INTERNAL_ERROR.
 */
export function fromFsError(error: unknown, relativePath: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return new WorkspaceError('FILE_NOT_FOUND', `${relativePath} does not exist`);
    case 'ENOTDIR':
      return new WorkspaceError('NOT_A_DIRECTORY', `a parent of ${relativePath} is not a directory`);
    case 'EISDIR':
      return new WorkspaceError('NOT_A_FILE', `${relativePath} is a directory`);
    case 'EACCES':
    case 'EPERM':
      return new WorkspaceError('PERMISSION_DENIED', `permission denied for ${relativePath}`);
    case 'ELOOP':
      return new WorkspaceError('INVALID_PATH', `${relativePath} has too many levels of symbolic links`);
    default:
      throw error;
  }
}
