import { parseArgs } from 'node:util';

import type { Config } from './config/config.js';
import { DEFAULT_DENY_PATTERNS } from './policy/deny-list.js';
import { SERVER_NAME, SERVER_VERSION } from './server/server.js';

export type CliCommand = 'serve' | 'check' | 'version';

export const USAGE = `Usage: ${SERVER_NAME} [--check | --version]
  (no flag)  serve MCP over stdio using WORKSPACE_* environment variables
  --check    validate the configuration, print a summary to stderr, and exit
  --version  print the server version and exit`;

/** Returns undefined for anything but no argument or exactly one known flag, so typos fail instead of serving. */
export function parseCli(args: string[]): CliCommand | undefined {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { check: { type: 'boolean' }, version: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return undefined;
  }
  if (values.check && values.version) return undefined;
  if (values.check) return 'check';
  if (values.version) return 'version';
  return args.length === 0 ? 'serve' : undefined;
}

/**
 * Operator-facing summary for `--check`. It goes to the operator's own stderr, not to an
 * MCP client, so canonical roots and the audit path are shown (M47). Only `Config` fields
 * are printed, never raw environment values.
 */
export function describeConfig(config: Config): string[] {
  const { limits, audit } = config;
  const extra = config.denyPatterns.slice(DEFAULT_DENY_PATTERNS.length);
  return [
    `${SERVER_NAME} ${SERVER_VERSION}: configuration OK (${config.multi ? 'WORKSPACE_ROOTS' : 'WORKSPACE_ROOT'})`,
    ...config.workspaces.map(({ name, mode, root }) => `workspace "${name}" ${mode} ${root}`),
    `limits: max_read_bytes=${limits.maxReadBytes} max_write_bytes=${limits.maxWriteBytes} ` +
      `max_directory_entries=${limits.maxDirectoryEntries} max_depth=${limits.maxDepth} ` +
      `request_timeout_ms=${limits.requestTimeoutMs} max_search_files=${limits.maxSearchFiles}`,
    audit.path === undefined ? 'audit: stderr' : `audit: file ${audit.path} (rotate at ${audit.maxBytes} bytes)`,
    `deny: ${DEFAULT_DENY_PATTERNS.length} default patterns${extra.length > 0 ? `, extra: ${extra.join(', ')}` : ''}`,
  ];
}
