import { McpServer } from '@modelcontextprotocol/server';

import { stderrAuditSink, type AuditSink } from '../audit/audit-log.js';
import type { Config } from '../config/config.js';
import { PathGuard } from '../filesystem/path-guard.js';
import { createDenyMatcher } from '../policy/deny-list.js';
import { registerListDirectory } from '../tools/list-directory.js';
import { registerReadFile } from '../tools/read-file.js';
import { registerWorkspaceInfo } from '../tools/workspace-info.js';
import { registerWriteFile } from '../tools/write-file.js';

export const SERVER_NAME = 'private-workspace-mcp';
// Keep in sync with the `version` in package.json.
export const SERVER_VERSION = '0.1.0';

/** Returns the factory `serveStdio` calls to build the instance serving a connection. */
export function createServerFactory(config: Config, audit: AuditSink = stderrAuditSink): () => McpServer {
  const deps = { config, guard: new PathGuard(config.root, createDenyMatcher(config.denyPatterns)), audit };
  return () => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerWorkspaceInfo(server, deps);
    registerListDirectory(server, deps);
    registerReadFile(server, deps);
    registerWriteFile(server, deps);
    return server;
  };
}
