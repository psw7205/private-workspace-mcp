import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runTool, type ToolDeps } from './run-tool.js';

const sharedOutput = {
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
};

const singleOutputSchema = z.object({ name: z.string(), root: z.literal('.'), ...sharedOutput });
const multiOutputSchema = z.object({ workspaces: z.array(z.object({ name: z.string() })), ...sharedOutput });

export function registerWorkspaceInfo(server: McpServer, { config, audit }: ToolDeps): void {
  const description = config.multi
    ? 'Describe the workspaces this server exposes: their names, the access mode (read-only or read-write) they share, platform, and limits. ' +
      'Pass a name as `workspace` to the other tools; their paths are relative to that workspace root ".". Host paths are never revealed.'
    : 'Describe the workspace this server exposes: its name, access mode (read-only or read-write), platform, and limits. ' +
      'All tool paths are relative to the workspace root ".". The host path is never revealed.';
  const shared = {
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
  };
  const result = config.multi
    ? { workspaces: config.workspaces.map(({ name }) => ({ name })), ...shared }
    : { name: config.workspaces[0]?.name ?? '', root: '.' as const, ...shared };

  server.registerTool(
    'get_workspace_info',
    {
      title: 'Get workspace info',
      description,
      outputSchema: config.multi ? multiOutputSchema : singleOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (ctx) =>
      runTool({ tool: 'get_workspace_info', requestId: ctx.mcpReq.id, timeoutMs: config.limits.requestTimeoutMs, audit }, async () => ({
        result,
      })),
  );
}
