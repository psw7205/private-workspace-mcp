import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { editTextFile } from '../filesystem/file-editor.js';
import { guardFor, runTool, type ToolDeps } from './run-tool.js';
import { pathSchema, workspaceShape } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  replacements: z.number(),
  bytes_written: z.number(),
  revision: z.string(),
});

export function registerEditFile(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxReadBytes, maxWriteBytes, requestTimeoutMs } = config.limits;
  server.registerTool(
    'edit_file',
    {
      title: 'Edit file',
      description:
        'Replace exact text in an existing UTF-8 text file. Prefer this over write_file for changing part of a file. ' +
        '`old_string` must match the current content exactly (whitespace and line endings included) and occur once, ' +
        'unless `replace_all` is true; otherwise the edit fails with EDIT_NO_MATCH or EDIT_AMBIGUOUS and nothing changes. ' +
        'Pass the `revision` from read_file as `expected_revision`; the result returns the new revision for a follow-up edit. ' +
        `Files over ${maxReadBytes} bytes cannot be edited. Fails with READ_ONLY unless the operator enabled read-write mode.`,
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema,
        old_string: z.string().min(1).describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        expected_revision: z.string().describe('Revision returned by read_file, edit_file, or write_file'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence instead of requiring exactly one'),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, path, old_string, new_string, expected_revision, replace_all }, ctx) =>
      runTool({ tool: 'edit_file', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async () => {
        const result = await editTextFile(
          guardFor(deps, workspace),
          { mode: config.mode, maxReadBytes, maxWriteBytes },
          { path, oldString: old_string, newString: new_string, expectedRevision: expected_revision, replaceAll: replace_all },
        );
        return { result: { ...result }, bytesWritten: result.bytes_written };
      }),
  );
}
