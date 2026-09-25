import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuditRecord } from '../src/audit/audit-log.js';
import type { Config } from '../src/config/config.js';
import { writeTextFile } from '../src/filesystem/file-writer.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { computeRevision } from '../src/filesystem/revision.js';
import { registerEditFile } from '../src/tools/edit-file.js';
import { registerMultiEditFile } from '../src/tools/multi-edit-file.js';
import type { ToolDeps } from '../src/tools/run-tool.js';
import { registerWriteFile } from '../src/tools/write-file.js';
import { createFixture, GatedGuard, type Fixture } from './helpers.js';

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

// Each tool's write is held at the gate until after the client has its TIMEOUT result,
// so the outcome does not depend on how fast the filesystem is.
const cases: Array<[string, number, (revision: string) => Record<string, unknown>]> = [
  ['write_file', 2, (revision) => ({ path: 'README.md', content: 'late\n', expected_revision: revision })],
  [
    'edit_file',
    3,
    (revision) => ({ path: 'README.md', old_string: 'readme', new_string: 'late', expected_revision: revision }),
  ],
  [
    'multi_edit_file',
    3,
    (revision) => ({ path: 'README.md', edits: [{ old_string: 'readme', new_string: 'late' }], expected_revision: revision }),
  ],
];

describe('write tools after TIMEOUT (M43)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it.each(cases)('%s does not commit after the client got TIMEOUT', async (tool, gatedCall, args) => {
    const guard = new GatedGuard(fixture.realRoot, gatedCall);
    const config: Config = {
      workspaces: [{ name: 'main', root: fixture.realRoot, mode: 'read-write' }],
      multi: false,
      limits: {
        maxReadBytes: 1024,
        maxWriteBytes: 1024,
        maxDirectoryEntries: 100,
        maxDepth: 4,
        requestTimeoutMs: 50,
        maxSearchFiles: 100,
      },
      audit: { maxBytes: 1024 },
      denyPatterns: [],
      git: false,
    };
    const records: AuditRecord[] = [];
    const deps: ToolDeps = {
      config,
      workspaces: new Map([['main', { guard, mode: 'read-write', root: fixture.realRoot }]]),
      audit: (record) => records.push(record),
    };
    const server = new McpServer({ name: 'pwmcp-test', version: '0.0.0' });
    registerWriteFile(server, deps);
    registerEditFile(server, deps);
    registerMultiEditFile(server, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'pwmcp-test', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const original = computeRevision(await readFile(path.join(fixture.root, 'README.md')));
      const result = (await client.callTool({ name: tool, arguments: args(original) })) as ToolText;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? '{}').error.code).toBe('TIMEOUT');

      guard.open();
      // Queues behind the timed-out write on the path lock, and succeeds only if that write did not commit.
      await writeTextFile(
        new PathGuard(fixture.realRoot),
        { mode: 'read-write', maxReadBytes: 1024, maxWriteBytes: 1024 },
        { path: 'README.md', content: 'after\n', expectedRevision: original },
      );
      expect(await readFile(path.join(fixture.root, 'README.md'), 'utf8')).toBe('after\n');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ tool, ok: false, error_code: 'TIMEOUT' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
