import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { MAX_REGEX_LENGTH, searchText } from '../filesystem/file-search.js';
import { MAX_GLOB_LENGTH } from '../filesystem/glob.js';
import { guardFor, runTool, type ToolDeps } from './run-tool.js';
import { pathSchema, workspaceShape } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  query: z.string(),
  matches: z.array(z.object({ path: z.string(), line: z.number(), column: z.number(), text: z.string() })),
  files_searched: z.number(),
  truncated: z.boolean(),
  scan_limit_reached: z.boolean(),
});

export function registerSearchText(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxDirectoryEntries, maxReadBytes, maxSearchFiles, requestTimeoutMs } = config.limits;
  const defaultLimit = Math.min(100, maxDirectoryEntries);
  server.registerTool(
    'search_text',
    {
      title: 'Search text',
      description:
        'Search UTF-8 text files under a workspace directory for a literal string, at any depth. ' +
        'Set `regex` to true to match `query` as an RE2 regular expression instead (linear time; no backreferences or lookaround; ' +
        `\\d, \\w, \\b are ASCII-only; at most ${MAX_REGEX_LENGTH} characters; overly complex patterns are rejected). ` +
        'Matching is per line, so ^ and $ match at line boundaries. ' +
        'Returns the first match on each line with its 1-based line and column; long lines are cut around the match. ' +
        'Narrow the files with `glob` (relative to `path`, for example `**/*.ts`). ' +
        `Binary, non-UTF-8, and files over ${maxReadBytes} bytes are skipped, as are files ignored by .gitignore or .ignore unless \`include_ignored\` is true. ` +
        `A search visits at most ${maxSearchFiles} files; \`scan_limit_reached\` means narrow \`path\` or \`glob\`.`,
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema.default('.'),
        query: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[^\r\n]*$/, 'query must be a single line')
          .describe('Text to find within one line; an RE2 regex when `regex` is true'),
        glob: z.string().min(1).max(MAX_GLOB_LENGTH).optional().describe('Only search files whose path relative to `path` matches this glob'),
        regex: z.boolean().default(false).describe('Interpret `query` as an RE2 regular expression'),
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
    async ({ workspace, path, query, regex, glob, case_sensitive, include_ignored, limit }, ctx) =>
      runTool({ tool: 'search_text', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { bytesRead, ...result } = await searchText(
          guardFor(deps, workspace),
          { maxSearchFiles, maxReadBytes, signal },
          { path, query, glob, caseSensitive: case_sensitive, includeIgnored: include_ignored, limit, regex },
        );
        return { result, bytesRead };
      }),
  );
}
