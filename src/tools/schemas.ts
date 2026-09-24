import * as z from 'zod/v4';

import type { Config } from '../config/config.js';
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

export const pathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .describe('Path relative to the workspace root, using "/" separators. "." is the root. Absolute paths and ".." are rejected.');
