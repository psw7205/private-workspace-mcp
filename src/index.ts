#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createAuditSink } from './audit/audit-log.js';
import { loadConfig } from './config/config.js';
import { createServerFactory, SERVER_NAME } from './server/server.js';

// stdout is the MCP protocol channel; every diagnostic goes to stderr.
async function main(): Promise<void> {
  let config;
  try {
    config = await loadConfig(process.env);
  } catch (error) {
    console.error(`${SERVER_NAME}: invalid configuration: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const handle = serveStdio(createServerFactory(config, createAuditSink(config.audit)), {
    onerror: (error) => console.error(`${SERVER_NAME}: transport error: ${error.message}`),
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Do not let an in-flight call keep the child alive after its parent is gone.
    setTimeout(() => process.exit(0), 3000).unref();
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The parent (tunnel-client) closing our stdin means the connection is over.
  process.stdin.on('end', shutdown);

  console.error(`${SERVER_NAME} listening on stdio (workspace "${config.name}", ${config.mode})`);
}

void main();
