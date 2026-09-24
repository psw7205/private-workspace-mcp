import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { editTextFileMulti, MAX_EDITS, previewEditTextFileMulti } from '../filesystem/file-editor.js';
import { runTool, selectWorkspace, type ToolDeps } from './run-tool.js';
import { DRY_RUN_NOTE, dryRunOutputShape, dryRunSchema, pathSchema, workspaceShape, writeAccessNote } from './schemas.js';

const outputSchema = z.object({
  path: z.string(),
  replacements: z.number(),
  edit_replacements: z.array(z.number()),
  bytes_written: z.number(),
  revision: z.string(),
  ...dryRunOutputShape,
});

const editSchema = z.object({
  old_string: z.string().min(1).describe('Exact text to replace, matched against the result of the earlier edits'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().default(false).describe('Replace every occurrence instead of requiring exactly one'),
});

export function registerMultiEditFile(server: McpServer, deps: ToolDeps): void {
  const { config, audit } = deps;
  const { maxReadBytes, maxWriteBytes, requestTimeoutMs } = config.limits;
  server.registerTool(
    'multi_edit_file',
    {
      title: 'Edit file in several places',
      description:
        'Apply several exact-text replacements to one existing UTF-8 text file in a single atomic write. ' +
        'Use this instead of repeated edit_file calls when changing several places in the same file. ' +
        'Edits apply in order: each `old_string` is matched against the content produced by the earlier edits, ' +
        'and each follows the edit_file rules (exact match, one occurrence unless `replace_all`). ' +
        'If any edit fails, nothing changes and the error names it as edits[i]. ' +
        'Pass the `revision` from read_file as `expected_revision`; the result returns the new revision. ' +
        `At most ${MAX_EDITS} edits. Files over ${maxReadBytes} bytes cannot be edited. ${DRY_RUN_NOTE} ${writeAccessNote(config)}`,
      inputSchema: z.object({
        ...workspaceShape(config),
        path: pathSchema,
        edits: z.array(editSchema).min(1).max(MAX_EDITS).describe('Edits to apply in order'),
        expected_revision: z.string().describe('Revision returned by read_file, edit_file, multi_edit_file, or write_file'),
        dry_run: dryRunSchema,
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, path, edits, expected_revision, dry_run }, ctx) =>
      runTool(
        { tool: 'multi_edit_file', workspace, path, dryRun: dry_run, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit },
        async (signal) => {
          const { guard, mode } = selectWorkspace(deps, workspace);
          const options = { mode, maxReadBytes, maxWriteBytes, signal };
          const params = {
            path,
            edits: edits.map((edit) => ({
              oldString: edit.old_string,
              newString: edit.new_string,
              replaceAll: edit.replace_all,
            })),
            expectedRevision: expected_revision,
          };
          if (dry_run) return { result: { ...(await previewEditTextFileMulti(guard, options, params)) } };
          const result = await editTextFileMulti(guard, options, params);
          return { result: { ...result }, bytesWritten: result.bytes_written };
        },
      ),
  );
}
