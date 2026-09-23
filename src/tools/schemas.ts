import * as z from 'zod/v4';

export const pathSchema = z
  .string()
  .max(4096)
  .describe('Path relative to the workspace root, using "/" separators. "." is the root. Absolute paths and ".." are rejected.');
