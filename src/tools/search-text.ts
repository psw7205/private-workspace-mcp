import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { searchText } from '../filesystem/file-search.js';
import { runTool, type ToolDeps } from './run-tool.js';
import { pathSchema } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  query: z.string(),
  matches: z.array(z.object({ path: z.string(), line: z.number(), column: z.number(), text: z.string() })),
  files_searched: z.number(),
  truncated: z.boolean(),
  scan_limit_reached: z.boolean(),
});

export function registerSearchText(server: McpServer, { config, guard, audit }: ToolDeps): void {
  const { maxDirectoryEntries, maxReadBytes, maxSearchFiles, requestTimeoutMs } = config.limits;
  const defaultLimit = Math.min(100, maxDirectoryEntries);
  server.registerTool(
    'search_text',
    {
      title: 'Search text',
      description:
        'Search UTF-8 text files under a workspace directory for a literal string (not a regex), at any depth. ' +
        'Returns the first match on each line with its 1-based line and column; long lines are cut around the match. ' +
        'Narrow the files with `glob` (relative to `path`, for example `**/*.ts`). ' +
        `Binary, non-UTF-8, and files over ${maxReadBytes} bytes are skipped, as are files ignored by .gitignore or .ignore unless \`include_ignored\` is true. ` +
        `A search visits at most ${maxSearchFiles} files; \`scan_limit_reached\` means narrow \`path\` or \`glob\`.`,
      inputSchema: z.object({
        path: pathSchema.default('.'),
        query: z.string().min(1).max(1024).describe('Literal text to find'),
        glob: z.string().min(1).max(1024).optional().describe('Only search files whose path relative to `path` matches this glob'),
        case_sensitive: z.boolean().default(false),
        include_ignored: z.boolean().default(false).describe('Also search files ignored by .gitignore or .ignore'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(maxDirectoryEntries)
          .default(defaultLimit)
          .describe(`Maximum number of matches to return (default ${defaultLimit}, max ${maxDirectoryEntries})`),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, query, glob, case_sensitive, include_ignored, limit }, ctx) =>
      runTool({ tool: 'search_text', path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { bytesRead, ...result } = await searchText(
          guard,
          { maxSearchFiles, maxReadBytes, signal },
          { path, query, glob, caseSensitive: case_sensitive, includeIgnored: include_ignored, limit },
        );
        return { result, bytesRead };
      }),
  );
}
