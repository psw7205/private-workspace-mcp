import { McpServer } from '@modelcontextprotocol/server';

import { stderrAuditSink, type AuditSink } from '../audit/audit-log.js';
import type { Config } from '../config/config.js';
import { PathGuard } from '../filesystem/path-guard.js';
import type { GitRunner } from '../git/runner.js';
import { createDenyMatcher } from '../policy/deny-list.js';
import { registerEditFile } from '../tools/edit-file.js';
import { registerFindFiles } from '../tools/find-files.js';
import { registerGitTools } from '../tools/git-tools.js';
import { registerListDirectory } from '../tools/list-directory.js';
import { registerMultiEditFile } from '../tools/multi-edit-file.js';
import { registerReadFile } from '../tools/read-file.js';
import { registerSearchText } from '../tools/search-text.js';
import { registerWorkspaceInfo } from '../tools/workspace-info.js';
import { registerWriteFile } from '../tools/write-file.js';

export const SERVER_NAME = 'private-workspace-mcp';
// Keep in sync with the `version` in package.json.
export const SERVER_VERSION = '0.2.0';

/**
 * Returns the factory `serveStdio` calls to build the instance serving a connection. `git` is the
 * runner for `WORKSPACE_GIT=read-only`, created once at startup after `detectGit` (ADR-004 §2.9).
 */
export function createServerFactory(config: Config, audit: AuditSink = stderrAuditSink, git?: GitRunner): () => McpServer {
  if (config.git !== (git !== undefined)) throw new Error('the Git runner must be given exactly when WORKSPACE_GIT is set');
  const isDenied = createDenyMatcher(config.denyPatterns);
  const workspaces = new Map(
    config.workspaces.map(({ name, root, mode }) => [name, { guard: new PathGuard(root, isDenied), mode, root }]),
  );
  const deps = { config, workspaces, audit };
  return () => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerWorkspaceInfo(server, deps);
    registerListDirectory(server, deps);
    registerReadFile(server, deps);
    registerWriteFile(server, deps);
    registerEditFile(server, deps);
    registerMultiEditFile(server, deps);
    registerFindFiles(server, deps);
    registerSearchText(server, deps);
    if (git !== undefined) registerGitTools(server, deps, git);
    return server;
  };
}
