import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { findFiles } from '../filesystem/file-search.js';
import { runTool, type ToolDeps } from './run-tool.js';
import { pathSchema } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.number() })),
  truncated: z.boolean(),
  scan_limit_reached: z.boolean(),
});

export function registerFindFiles(server: McpServer, { config, guard, audit }: ToolDeps): void {
  const { maxDirectoryEntries, maxReadBytes, maxSearchFiles, requestTimeoutMs } = config.limits;
  server.registerTool(
    'find_files',
    {
      title: 'Find files',
      description:
        'Find files by glob under a workspace directory, at any depth. The pattern is matched against paths relative to `path`: ' +
        '`*` stays within one segment and `**` spans segments, so use `**/*.ts` for every .ts file and `*.ts` for the top level only. ' +
        'Names starting with "." match only when the pattern names them (for example `.github/**/*.yml`). ' +
        'Files ignored by `.gitignore` or `.ignore` are skipped unless `include_ignored` is true. ' +
        'Symlinks are not followed and sensitive files are always omitted. ' +
        `A search visits at most ${maxSearchFiles} files; \`scan_limit_reached\` means narrow \`path\` or the pattern.`,
      inputSchema: z.object({
        path: pathSchema.default('.'),
        pattern: z.string().min(1).max(1024).describe('Glob relative to `path`, for example `src/**/*.test.ts`'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(maxDirectoryEntries)
          .default(maxDirectoryEntries)
          .describe(`Maximum number of files to return (max ${maxDirectoryEntries})`),
        include_ignored: z.boolean().default(false).describe('Also return files ignored by .gitignore or .ignore'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, pattern, limit, include_ignored }, ctx) =>
      runTool({ tool: 'find_files', path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => ({
        result: {
          ...(await findFiles(
            guard,
            { maxSearchFiles, maxReadBytes, signal },
            { path, pattern, limit, includeIgnored: include_ignored },
          )),
        },
      })),
  );
}
