#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createAuditSink } from './audit/audit-log.js';
import { describeConfig, parseCli, USAGE } from './cli.js';
import { loadConfig } from './config/config.js';
import { createServerFactory, SERVER_NAME, SERVER_VERSION } from './server/server.js';

// While serving, stdout is the MCP protocol channel and every diagnostic goes to stderr.
// Only `--version`, which never serves, writes to stdout.
async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));
  if (command === undefined) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command === 'version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config;
  try {
    config = await loadConfig(process.env);
  } catch (error) {
    console.error(`${SERVER_NAME}: invalid configuration: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (command === 'check') {
    // No transport, no audit sink, no stdin/signal handlers: the process exits once stderr drains.
    console.error(describeConfig(config).join('\n'));
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

  const described = config.multi
    ? `workspaces ${config.workspaces.map(({ name, mode }) => `"${name}" ${mode}`).join(', ')}`
    : config.workspaces.map(({ name, mode }) => `workspace "${name}", ${mode}`).join('');
  console.error(`${SERVER_NAME} listening on stdio (${described})`);
}

void main();
