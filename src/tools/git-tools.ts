import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { DEFAULT_LOG_COUNT, gitDiff, gitLog, gitShow, gitStatus, MAX_LOG_COUNT } from '../git/operations.js';
import type { GitContext } from '../git/repository.js';
import type { GitRunner } from '../git/runner.js';
import { runTool, selectWorkspace, type ToolDeps } from './run-tool.js';
import { pathSchema, workspaceShape } from './schemas.js';

const revSchema = z.string().min(1).max(256);
const personSchema = z.object({ name: z.string(), email: z.string(), date: z.string() });
const commitSchema = z.object({
  oid: z.string(),
  parents: z.array(z.string()),
  author: personSchema,
  committer: personSchema,
  message: z.string(),
});
const fileSchema = z.object({ path: z.string(), orig_path: z.string().optional(), status: z.string() });
const diffShape = { files: z.array(fileSchema), patch: z.string(), truncated: z.boolean() };

const REV_NOTE =
  'Revisions are HEAD, a commit id (4 to 64 hex digits), or a branch, tag, or remote-tracking branch name, optionally followed by ~N or ^N; ' +
  'ranges, reflog (@{...}), rev:path, stash, and notes are rejected with INVALID_REVISION.';
const COMMON_NOTE =
  'Files matching the sensitive file policy are omitted, as if they did not exist. ' +
  'Fails with NOT_A_REPOSITORY unless the workspace root is itself a Git repository toplevel with a .git directory.';

/** The four read-only Git tools of ADR-004. Registered only with `WORKSPACE_GIT=read-only` (§2.9). */
export function registerGitTools(server: McpServer, deps: ToolDeps, runner: GitRunner): void {
  const { config, audit } = deps;
  const { maxReadBytes, requestTimeoutMs } = config.limits;
  const roots = config.workspaces.map(({ root }) => root);
  const contextFor = (workspace: unknown): GitContext => {
    const selected = selectWorkspace(deps, workspace);
    return {
      runner,
      root: selected.root,
      guard: selected.guard,
      roots,
      isDenied: selected.guard.isDenied,
      denyPatterns: config.denyPatterns,
      maxBytes: maxReadBytes,
    };
  };
  const annotations = { readOnlyHint: true, openWorldHint: false };
  const cut = `Output beyond ${maxReadBytes} bytes per git command is cut and \`truncated\` is true.`;

  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description:
        'Show the current branch, whether it differs from its upstream (no ahead/behind counts), and the changed files with their ' +
        'index and worktree status letters (porcelain v2: `.` unchanged, `M` modified, `A` added, `D` deleted, `?` untracked; untracked files are listed one by one). ' +
        `Renames are not detected. ${COMMON_NOTE} ${cut}`,
      inputSchema: z.object({ ...workspaceShape(config) }),
      outputSchema: z.object({
        branch: z.string().nullable(),
        oid: z.string().nullable(),
        upstream: z.string().nullable(),
        upstream_differs: z.boolean().nullable(),
        entries: z.array(
          z.object({ path: z.string(), orig_path: z.string().optional(), index: z.string(), worktree: z.string() }),
        ),
        truncated: z.boolean(),
      }),
      annotations,
    },
    async ({ workspace }, ctx) =>
      runTool({ tool: 'git_status', workspace, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { result, bytesRead, truncated } = await gitStatus(contextFor(workspace), signal);
        return { result: { ...result }, bytesRead, truncated };
      }),
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description:
        'Show changed files and a unified patch. Without `base`, compares the worktree with the index; with `staged`, the index with HEAD; ' +
        'with `base`, the commit `base` with `head` (default HEAD). Untracked files are not included (see git_status). ' +
        `Binary files appear as a single "Binary files ... differ" line. ${REV_NOTE} ${COMMON_NOTE} ${cut}`,
      inputSchema: z.object({
        ...workspaceShape(config),
        base: revSchema.optional().describe('Commit to compare from'),
        head: revSchema.optional().describe('Commit to compare to (default HEAD); requires base'),
        staged: z.boolean().default(false).describe('Compare the index with HEAD instead of the worktree with the index'),
        path: pathSchema.optional().describe('Limit to this file or directory; it need not exist anymore'),
      }),
      outputSchema: z.object(diffShape),
      annotations,
    },
    async ({ workspace, base, head, staged, path }, ctx) =>
      runTool({ tool: 'git_diff', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { result, bytesRead, truncated } = await gitDiff(contextFor(workspace), { base, head, staged, path }, signal);
        return { result: { ...result }, bytesRead, truncated };
      }),
  );

  server.registerTool(
    'git_log',
    {
      title: 'Git log',
      description:
        'List commits reachable from `rev` (default HEAD), newest first, with parents, author, committer, and full message. ' +
        `Set \`path\` to only list commits that touched it. Changed files are not listed (use git_show). ${REV_NOTE} ` +
        'Commit messages and author names are returned as recorded. ' +
        `Fails with NOT_A_REPOSITORY unless the workspace root is itself a Git repository toplevel with a .git directory. ${cut}`,
      inputSchema: z.object({
        ...workspaceShape(config),
        rev: revSchema.optional().describe('Commit to start from (default HEAD)'),
        path: pathSchema.optional().describe('Only commits that changed this file or directory; it need not exist anymore'),
        max_count: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_COUNT)
          .default(DEFAULT_LOG_COUNT)
          .describe(`Maximum number of commits (default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT})`),
      }),
      outputSchema: z.object({ commits: z.array(commitSchema), truncated: z.boolean() }),
      annotations,
    },
    async ({ workspace, rev, path, max_count }, ctx) =>
      runTool({ tool: 'git_log', workspace, path, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { result, bytesRead, truncated } = await gitLog(contextFor(workspace), { rev, path, max_count }, signal);
        return { result: { ...result }, bytesRead, truncated };
      }),
  );

  server.registerTool(
    'git_show',
    {
      title: 'Git show',
      description:
        'Show one commit: its metadata and message, the files it changed against its first parent (a root commit against the empty tree), and the unified patch. ' +
        `${REV_NOTE} ${COMMON_NOTE} ${cut}`,
      inputSchema: z.object({ ...workspaceShape(config), rev: revSchema.describe('Commit to show') }),
      outputSchema: z.object({ commit: commitSchema, ...diffShape }),
      annotations,
    },
    async ({ workspace, rev }, ctx) =>
      runTool({ tool: 'git_show', workspace, requestId: ctx.mcpReq.id, timeoutMs: requestTimeoutMs, audit }, async (signal) => {
        const { result, bytesRead, truncated } = await gitShow(contextFor(workspace), { rev }, signal);
        return { result: { ...result }, bytesRead, truncated };
      }),
  );
}
