import * as z from 'zod/v4';

import type { Config } from '../config/config.js';
import { MAX_DIFF_BYTES } from '../filesystem/edit-diff.js';
import { MAX_PATH_LENGTH } from '../filesystem/path-guard.js';

/** Input fields for choosing a workspace: a required `workspace` in multi mode, none otherwise (ADR-008). */
export function workspaceShape(config: Config): { workspace?: z.ZodEnum<Record<string, string>> } {
  const [first, ...rest] = config.workspaces.map((workspace) => workspace.name);
  if (!config.multi || first === undefined) return {};
  return {
    workspace: z
      .enum([first, ...rest])
      .describe('Name of the workspace to use; get_workspace_info lists them. Paths are relative to its root.'),
  };
}

/** The last sentence of the write tools' descriptions: which workspaces accept writes (ADR-008 Amendment). */
export function writeAccessNote(config: Config): string {
  if (!config.multi) return 'Fails with READ_ONLY unless the operator enabled read-write mode.';
  const writable = config.workspaces.filter(({ mode }) => mode === 'read-write').map(({ name }) => name);
  if (writable.length === 0) return 'Every workspace is read-only, so this fails with READ_ONLY.';
  const rest = writable.length < config.workspaces.length ? ' Other workspaces fail with READ_ONLY.' : '';
  return `Writable workspaces: ${writable.join(', ')}.${rest}`;
}

/** Input field shared by edit_file and multi_edit_file (M49). */
export const dryRunSchema = z
  .boolean()
  .default(false)
  .describe('Check the edit and return the would-be revision and a unified diff without writing');

/** Output fields present only on a dry run; bytes_written is then 0. */
export const dryRunOutputShape = {
  dry_run: z.literal(true).optional(),
  diff: z.string().optional(),
  diff_truncated: z.boolean().optional(),
};

/** Description sentence for the edit tools; goes before writeAccessNote. */
export const DRY_RUN_NOTE =
  'Set `dry_run` to run every check without writing: the result then has `dry_run: true`, `bytes_written: 0`, ' +
  `the \`revision\` the edit would produce, and a unified \`diff\` (3 context lines, cut at ${MAX_DIFF_BYTES} bytes with \`diff_truncated\`). ` +
  'To apply it, repeat the call without `dry_run` and the same `expected_revision`.';

export const pathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .describe('Path relative to the workspace root, using "/" separators. "." is the root. Absolute paths and ".." are rejected.');
