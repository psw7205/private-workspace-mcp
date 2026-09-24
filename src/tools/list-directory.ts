import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { listDirectory } from '../filesystem/directory-lister.js';
import { guardFor, runTool, type ToolDeps } from './run-tool.js';
import { pathSchema, workspaceShape } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(['file', 'directory', 'symlink']),
      size: z.number().optional(),
    }),
  ),
  truncated: z.boolean(),
});

export function registerListDirectory(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxDepth, maxDirectoryEntries, requestTimeoutMs } = config.limits;
  server.registerTool(
    'list_directory',
    {
      title: 'List directory',
      description:
        'List entries of a workspace directory, sorted by name, depth-first. Symlinks are reported with type "symlink" and never followed. ' +
        'Sensitive files (for example .env, keys, .git) are omitted. `truncated` is true when the entry limit cut the listing short.',
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema.default('.'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(maxDepth)
          .default(1)
          .describe(`How many levels to descend; 1 lists immediate children only (max ${maxDepth})`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(maxDirectoryEntries)
          .default(maxDirectoryEntries)
          .describe(`Maximum number of entries to return (max ${maxDirectoryEntries})`),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace, path, depth, limit }, ctx) =>
      runTool({ tool: 'list_directory', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async () => ({
        result: { ...(await listDirectory(guardFor(deps, workspace), { path, depth, limit })) },
      })),
  );
}
