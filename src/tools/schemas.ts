import * as z from 'zod/v4';

import { MAX_PATH_LENGTH } from '../filesystem/path-guard.js';

export const pathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .describe('Path relative to the workspace root, using "/" separators. "." is the root. Absolute paths and ".." are rejected.');
