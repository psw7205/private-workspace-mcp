import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { previewWriteTextFile, writeTextFile } from '../filesystem/file-writer.js';
import { runTool, selectWorkspace, type ToolDeps } from './run-tool.js';
import { DRY_RUN_NOTE, dryRunOutputShape, dryRunSchema, pathSchema, workspaceShape, writeAccessNote } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  bytes_written: z.number(),
  revision: z.string(),
  ...dryRunOutputShape,
});

export function registerWriteFile(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxReadBytes, maxWriteBytes, requestTimeoutMs } = config.limits;
  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Create a UTF-8 text file or replace an existing one with the full new content. ' +
        'To change part of an existing file, prefer edit_file or multi_edit_file. ' +
        'To replace an existing file, first read_file it and pass its `revision` as `expected_revision`; the write fails with REVISION_CONFLICT if the file changed since. ' +
        'To create a new file, omit `expected_revision`; missing parent directories are created. ' +
        `Content is limited to ${maxWriteBytes} bytes, and files over ${maxReadBytes} bytes cannot be replaced. ` +
        `${DRY_RUN_NOTE} ${writeAccessNote(config)}`,
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema,
        content: z.string().describe('Complete new file content'),
        expected_revision: z
          .string()
          .optional()
          .describe('Revision returned by read_file; required when the file exists, omitted to create a new file'),
        dry_run: dryRunSchema,
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, path, content, expected_revision, dry_run }, ctx) =>
      runTool(
        { tool: 'write_file', workspace, path, dryRun: dry_run, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit },
        async (signal) => {
          const { guard, mode } = selectWorkspace(deps, workspace);
          const options = { mode, maxReadBytes, maxWriteBytes, signal };
          const params = { path, content, expectedRevision: expected_revision };
          if (dry_run) return { result: { ...(await previewWriteTextFile(guard, options, params)) } };
          const result = await writeTextFile(guard, options, params);
          return { result: { ...result }, bytesWritten: result.bytes_written };
        },
      ),
  );
}
