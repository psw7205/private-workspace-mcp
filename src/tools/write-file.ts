import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { writeTextFile } from '../filesystem/file-writer.js';
import { runTool, type ToolDeps } from './run-tool.js';
import { pathSchema } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  bytes_written: z.number(),
  revision: z.string(),
});

export function registerWriteFile(server: McpServer, { config, guard, audit }: ToolDeps): void {
  const { maxWriteBytes, requestTimeoutMs } = config.limits;
  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Create a UTF-8 text file or replace an existing one with the full new content. ' +
        'To replace an existing file, first read_file it and pass its `revision` as `expected_revision`; the write fails with REVISION_CONFLICT if the file changed since. ' +
        'To create a new file, omit `expected_revision`; missing parent directories are created. ' +
        `Content is limited to ${maxWriteBytes} bytes. Fails with READ_ONLY unless the operator enabled read-write mode.`,
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().describe('Complete new file content'),
        expected_revision: z
          .string()
          .optional()
          .describe('Revision returned by read_file; required when the file exists, omitted to create a new file'),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, content, expected_revision }, ctx) =>
      runTool({ tool: 'write_file', path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async () => {
        const result = await writeTextFile(
          guard,
          { mode: config.mode, maxWriteBytes },
          { path, content, expectedRevision: expected_revision },
        );
        return { result: { ...result }, bytesWritten: result.bytes_written };
      }),
  );
}
