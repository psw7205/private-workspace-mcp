import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixture, expectNoHostPath, type Fixture } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverArgs = ['--import', 'tsx', path.join(projectRoot, 'src/index.ts')];

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function parseText(result: unknown): any {
  const text = (result as ToolText).content[0]?.text;
  if (text === undefined) throw new Error('tool result has no text content');
  return JSON.parse(text);
}

async function connect(env: Record<string, string>, versionNegotiation?: ClientOptions['versionNegotiation']) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: projectRoot,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: 'pwmcp-test', version: '0.0.0' },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const stopCases: Array<[string, (child: ChildProcess) => void]> = [
  ['stdin closes', (child) => void child.stdin?.end()],
];
// Windows has no POSIX signals: kill() terminates the process without running handlers.
if (process.platform !== 'win32') stopCases.push(['SIGTERM arrives', (child) => void child.kill('SIGTERM')]);

describe('stdio server', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  describe('read-write mode over a 2025-era (legacy initialize) connection', () => {
    let session: Awaited<ReturnType<typeof connect>>;

    beforeAll(async () => {
      session = await connect({ WORKSPACE_ROOT: fixture.root, WORKSPACE_MODE: 'read-write', WORKSPACE_MAX_DEPTH: '2' });
      expect(session.client.getProtocolEra()).toBe('legacy');
    });

    afterAll(async () => {
      await session.client.close();
    });

    it('advertises exactly the four MVP tools with behavior hints', async () => {
      const { tools } = await session.client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(Object.keys(byName).sort()).toEqual(['get_workspace_info', 'list_directory', 'read_file', 'write_file']);
      expect(byName.read_file?.annotations?.readOnlyHint).toBe(true);
      expect(byName.list_directory?.annotations?.readOnlyHint).toBe(true);
      expect(byName.write_file?.annotations?.destructiveHint).toBe(true);
    });

    it('describes the workspace without exposing the host path', async () => {
      const result = await session.client.callTool({ name: 'get_workspace_info', arguments: {} });
      const info = parseText(result);
      expect(info).toMatchObject({
        name: 'workspace',
        root: '.',
        mode: 'read-write',
        platform: process.platform,
        limits: { max_read_bytes: 1_048_576, max_depth: 2 },
      });
      expectNoHostPath(JSON.stringify(result), fixture);
    });

    it('lists, reads, and writes with revision checks', async () => {
      const listing = parseText(await session.client.callTool({ name: 'list_directory', arguments: { path: '.' } }));
      expect(listing.entries.map((entry: { path: string }) => entry.path)).toContain('README.md');

      const read = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }));
      expect(read.content).toBe('# readme\n');

      const written = parseText(
        await session.client.callTool({
          name: 'write_file',
          arguments: { path: 'README.md', content: '# v2\n', expected_revision: read.revision },
        }),
      );
      expect(written.created).toBe(false);

      const stale = await session.client.callTool({
        name: 'write_file',
        arguments: { path: 'README.md', content: '# v3\n', expected_revision: read.revision },
      });
      expect((stale as ToolText).isError).toBe(true);
      expect(parseText(stale).error.code).toBe('REVISION_CONFLICT');
    });

    it('returns classified errors for escapes and denied files without host paths', async () => {
      for (const [args, code] of [
        [{ path: '../outside/secret.txt' }, 'PATH_OUTSIDE_WORKSPACE'],
        [{ path: 'link-outside-file' }, 'PATH_OUTSIDE_WORKSPACE'],
        [{ path: '.env' }, 'PATH_BLOCKED'],
      ] as const) {
        const result = await session.client.callTool({ name: 'read_file', arguments: args });
        expect((result as ToolText).isError).toBe(true);
        expect(parseText(result).error.code).toBe(code);
        expectNoHostPath(JSON.stringify(result), fixture);
      }
    });

    it('rejects a depth above the configured maximum before running', async () => {
      const result = await session.client.callTool({ name: 'list_directory', arguments: { path: '.', depth: 3 } });
      expect((result as ToolText).isError).toBe(true);
    });

    it('writes one JSON audit line per call to stderr, without file content', async () => {
      await session.client.callTool({ name: 'read_file', arguments: { path: 'src/index.ts' } });
      const records = session
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const readAudit = records.find((record) => record.tool === 'read_file' && record.path === 'src/index.ts');
      expect(readAudit).toMatchObject({ event: 'tool_call', ok: true, bytes_read: 11 });
      expect(readAudit.request_id).toBeDefined();
      expect(session.stderr()).not.toContain('export {};');
    });
  });

  it('serves a 2026-07-28 (stateless) connection', async () => {
    const session = await connect({ WORKSPACE_ROOT: fixture.root }, { mode: { pin: '2026-07-28' } });
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const { tools } = await session.client.listTools();
      expect(tools).toHaveLength(4);
      const read = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'src/index.ts' } }));
      expect(read.content).toBe('export {};\n');
    } finally {
      await session.client.close();
    }
  });

  it('writes audit records to WORKSPACE_AUDIT_LOG instead of stderr', async () => {
    const auditLog = path.join(fixture.outside, 'audit.jsonl');
    const session = await connect({ WORKSPACE_ROOT: fixture.root, WORKSPACE_AUDIT_LOG: auditLog });
    try {
      await session.client.callTool({ name: 'read_file', arguments: { path: 'src/index.ts' } });
      const records = (await readFile(auditLog, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ tool: 'read_file', path: 'src/index.ts', ok: true });
      expect(session.stderr()).not.toContain('"event":"tool_call"');
    } finally {
      await session.client.close();
      await rm(auditLog, { force: true });
    }
  });

  it('applies WORKSPACE_EXTRA_DENY_PATTERNS on top of the defaults', async () => {
    const session = await connect({ WORKSPACE_ROOT: fixture.root, WORKSPACE_EXTRA_DENY_PATTERNS: 'README*' });
    try {
      const readme = await session.client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
      expect(parseText(readme).error.code).toBe('PATH_BLOCKED');
      const env = await session.client.callTool({ name: 'read_file', arguments: { path: '.env' } });
      expect(parseText(env).error.code).toBe('PATH_BLOCKED');
    } finally {
      await session.client.close();
    }
  });

  it('is read-only unless read-write is configured', async () => {
    const session = await connect({ WORKSPACE_ROOT: fixture.root });
    try {
      const result = await session.client.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 'x' } });
      expect(parseText(result).error.code).toBe('READ_ONLY');
    } finally {
      await session.client.close();
    }
  });

  it('refuses to start without a valid workspace root', async () => {
    const child = spawn(process.execPath, serverArgs, {
      cwd: projectRoot,
      env: { ...getDefaultEnvironment(), WORKSPACE_ROOT: 'relative/path' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const [code] = await once(child, 'exit');
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
  });

  it.each(stopCases)('exits cleanly when %s', async (_label, stop) => {
    const child = spawn(process.execPath, serverArgs, {
      cwd: projectRoot,
      env: { ...getDefaultEnvironment(), WORKSPACE_ROOT: fixture.root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise<void>((resolve) => {
      const check = () => (stderr.includes('listening on stdio') ? resolve() : setTimeout(check, 20));
      check();
    });

    const exited = once(child, 'exit');
    stop(child);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('server did not exit')), 5000));
    const [code] = (await Promise.race([exited, timeout])) as [number | null];
    expect(code).toBe(0);
  });
});
