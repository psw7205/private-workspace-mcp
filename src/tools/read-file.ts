import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { DEFAULT_MAX_LINES, readTextFile } from '../filesystem/file-reader.js';
import { guardFor, runTool, type ToolDeps } from './run-tool.js';
import { pathSchema, workspaceShape } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
  total_lines: z.number(),
  start_line: z.number(),
  end_line: z.number(),
  truncated: z.boolean(),
  next_start_line: z.number().optional(),
  revision: z.string(),
});

export function registerReadFile(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxReadBytes, requestTimeoutMs } = config.limits;
  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        `Read a UTF-8 text file from the workspace, optionally a window of lines. Files over ${maxReadBytes} bytes, binary files, and files that are not valid UTF-8 are rejected. ` +
        'When `truncated` is true, call again with `start_line` = `next_start_line`. ' +
        '`revision` identifies the whole file content; pass it as `expected_revision` to write_file to replace the file safely.',
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema,
        start_line: z.number().int().min(1).optional().describe('1-based first line to return (default 1)'),
        max_lines: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Maximum number of lines to return (default ${DEFAULT_MAX_LINES})`),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace, path, start_line, max_lines }, ctx) =>
      runTool({ tool: 'read_file', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async () => {
        const result = await readTextFile(guardFor(deps, workspace), { maxReadBytes }, { path, startLine: start_line, maxLines: max_lines });
        return { result: { ...result }, bytesRead: result.size };
      }),
  );
}
