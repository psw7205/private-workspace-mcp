import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runTool, type ToolDeps } from './run-tool.js';

const outputSchema = z.object({
  name: z.string(),
  root: z.literal('.'),
  mode: z.enum(['read-only', 'read-write']),
  platform: z.string(),
  limits: z.object({
    max_read_bytes: z.number(),
    max_write_bytes: z.number(),
    max_directory_entries: z.number(),
    max_depth: z.number(),
    request_timeout_ms: z.number(),
    max_search_files: z.number(),
  }),
});

export function registerWorkspaceInfo(server: McpServer, { config, audit }: ToolDeps): void {
  server.registerTool(
    'get_workspace_info',
    {
      title: 'Get workspace info',
      description:
        'Describe the workspace this server exposes: its name, access mode (read-only or read-write), platform, and limits. ' +
        'All tool paths are relative to the workspace root ".". The host path is never revealed.',
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (ctx) =>
      runTool({ tool: 'get_workspace_info', requestId: ctx.mcpReq.id, timeoutMs: config.limits.requestTimeoutMs, audit }, async () => ({
        result: {
          name: config.name,
          root: '.' as const,
          mode: config.mode,
          platform: process.platform,
          limits: {
            max_read_bytes: config.limits.maxReadBytes,
            max_write_bytes: config.limits.maxWriteBytes,
            max_directory_entries: config.limits.maxDirectoryEntries,
            max_depth: config.limits.maxDepth,
            request_timeout_ms: config.limits.requestTimeoutMs,
            max_search_files: config.limits.maxSearchFiles,
          },
        },
      })),
  );
}
