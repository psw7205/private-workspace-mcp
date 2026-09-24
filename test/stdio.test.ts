import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixture, expectNoHostPath, type Fixture } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// TEST_SERVER_ENTRY runs this suite against a built artifact (e.g. release/index.mjs) instead of the source.
const serverArgs = process.env.TEST_SERVER_ENTRY
  ? [path.resolve(projectRoot, process.env.TEST_SERVER_ENTRY)]
  : ['--import', 'tsx', path.join(projectRoot, 'src/index.ts')];

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

/** Runs the entry with CLI arguments to completion; stdin stays open so a serve-mode regression times out. */
async function runCli(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [...serverArgs, ...args], {
    cwd: projectRoot,
    env: { ...getDefaultEnvironment(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  // 'close', not 'exit': stdio may still hold unread output when 'exit' fires.
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
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

    it('reports the package.json version', async () => {
      // SERVER_VERSION is a hand-kept copy; releases are tagged from package.json.
      const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
      expect(session.client.getServerVersion()).toMatchObject({ name: 'private-workspace-mcp', version: pkg.version });
    });

    it('advertises exactly the workspace tools with behavior hints', async () => {
      const { tools } = await session.client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(Object.keys(byName).sort()).toEqual([
        'edit_file',
        'find_files',
        'get_workspace_info',
        'list_directory',
        'multi_edit_file',
        'read_file',
        'search_text',
        'write_file',
      ]);
      expect(byName.read_file?.annotations?.readOnlyHint).toBe(true);
      expect(byName.list_directory?.annotations?.readOnlyHint).toBe(true);
      expect(byName.find_files?.annotations?.readOnlyHint).toBe(true);
      expect(byName.search_text?.annotations?.readOnlyHint).toBe(true);
      expect(byName.write_file?.annotations?.destructiveHint).toBe(true);
      expect(byName.edit_file?.annotations?.destructiveHint).toBe(true);
      expect(byName.multi_edit_file?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.multi_edit_file?.inputSchema.properties?.edits).toMatchObject({ type: 'array', minItems: 1, maxItems: 100 });
      // v0.1.0 edit_file input stays as released, plus the optional dry_run (M49).
      expect(Object.keys(byName.edit_file?.inputSchema.properties ?? {}).sort()).toEqual([
        'dry_run',
        'expected_revision',
        'new_string',
        'old_string',
        'path',
        'replace_all',
      ]);
      for (const name of ['edit_file', 'multi_edit_file']) {
        expect(byName[name]?.inputSchema.properties?.dry_run, name).toMatchObject({ type: 'boolean', default: false });
        expect(byName[name]?.inputSchema.required ?? [], name).not.toContain('dry_run');
        expect(byName[name]?.outputSchema?.required, name).toEqual(expect.arrayContaining(['bytes_written', 'revision']));
      }
      for (const tool of tools) expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('workspace');
      for (const name of ['write_file', 'edit_file', 'multi_edit_file']) {
        expect(byName[name]?.description, name).toMatch(/Fails with READ_ONLY unless the operator enabled read-write mode\.$/);
      }
    });

    it('previews edits with dry_run without writing and audits the flag', async () => {
      const read = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'src/index.ts' } }));
      const preview = await session.client.callTool({
        name: 'edit_file',
        arguments: { path: 'src/index.ts', old_string: 'export', new_string: 'import', expected_revision: read.revision, dry_run: true },
      });
      expect(preview.structuredContent).toEqual({
        path: 'src/index.ts',
        dry_run: true,
        replacements: 1,
        bytes_written: 0,
        revision: expect.stringMatching(/^sha256:/),
        diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export {};\n+import {};\n',
        diff_truncated: false,
      });
      expectNoHostPath(JSON.stringify(preview), fixture);

      const multiPreview = parseText(
        await session.client.callTool({
          name: 'multi_edit_file',
          arguments: {
            path: 'src/index.ts',
            expected_revision: read.revision,
            dry_run: true,
            edits: [
              { old_string: 'export', new_string: 'import' },
              { old_string: '{}', new_string: '{ x }' },
            ],
          },
        }),
      );
      expect(multiPreview).toMatchObject({ dry_run: true, replacements: 2, edit_replacements: [1, 1], bytes_written: 0 });
      expect(multiPreview.diff).toContain('+import { x };\n');

      const failed = await session.client.callTool({
        name: 'edit_file',
        arguments: { path: 'src/index.ts', old_string: 'missing', new_string: 'x', expected_revision: read.revision, dry_run: true },
      });
      expect(parseText(failed).error.code).toBe('EDIT_NO_MATCH');

      const after = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'src/index.ts' } }));
      expect(after).toMatchObject({ content: 'export {};\n', revision: read.revision });

      // Without dry_run the output keeps the v0.1.0 shape.
      const applied = await session.client.callTool({
        name: 'edit_file',
        arguments: { path: 'src/index.ts', old_string: 'export', new_string: 'import', expected_revision: read.revision },
      });
      expect(Object.keys(applied.structuredContent ?? {}).sort()).toEqual(['bytes_written', 'path', 'replacements', 'revision']);
      expect((applied.structuredContent as { revision: string }).revision).toBe((preview.structuredContent as { revision: string }).revision);
      await session.client.callTool({
        name: 'write_file',
        arguments: { path: 'src/index.ts', content: 'export {};\n', expected_revision: (applied.structuredContent as { revision: string }).revision },
      });

      const records = session
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((record) => record.path === 'src/index.ts' && ['edit_file', 'multi_edit_file'].includes(record.tool));
      expect(records.map((record) => [record.tool, record.ok, record.dry_run, record.bytes_written])).toEqual([
        ['edit_file', true, true, undefined],
        ['multi_edit_file', true, true, undefined],
        ['edit_file', false, true, undefined],
        ['edit_file', true, undefined, 11],
      ]);
      expect(session.stderr()).not.toContain('import {}');
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
      expect(Object.keys(info)).toEqual(['name', 'root', 'mode', 'platform', 'limits']);
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

      const edited = parseText(
        await session.client.callTool({
          name: 'edit_file',
          arguments: { path: 'README.md', old_string: 'v2', new_string: 'v3', expected_revision: written.revision },
        }),
      );
      expect(edited).toMatchObject({ path: 'README.md', replacements: 1 });
      const reread = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }));
      expect(reread).toMatchObject({ content: '# v3\n', revision: edited.revision });

      const failed = await session.client.callTool({
        name: 'multi_edit_file',
        arguments: {
          path: 'README.md',
          expected_revision: edited.revision,
          edits: [
            { old_string: 'v3', new_string: 'v4' },
            { old_string: 'missing', new_string: 'x' },
          ],
        },
      });
      expect((failed as ToolText).isError).toBe(true);
      expect(parseText(failed).error.code).toBe('EDIT_NO_MATCH');
      expect(parseText(failed).error.message).toContain('edits[1]');
      expectNoHostPath(JSON.stringify(failed), fixture);

      const multi = parseText(
        await session.client.callTool({
          name: 'multi_edit_file',
          arguments: {
            path: 'README.md',
            expected_revision: edited.revision,
            edits: [
              { old_string: 'v3', new_string: 'v4' },
              { old_string: '# v4', new_string: '## v4' },
            ],
          },
        }),
      );
      expect(multi).toMatchObject({ path: 'README.md', replacements: 2, edit_replacements: [1, 1] });
      const final = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }));
      expect(final).toMatchObject({ content: '## v4\n', revision: multi.revision });
    });

    it('returns classified errors for escapes and denied files without host paths', async () => {
      for (const [args, code] of [
        [{ path: '../outside/private.txt' }, 'PATH_OUTSIDE_WORKSPACE'],
        [{ path: 'link-outside-file' }, 'PATH_OUTSIDE_WORKSPACE'],
        [{ path: '.env' }, 'PATH_BLOCKED'],
      ] as const) {
        const result = await session.client.callTool({ name: 'read_file', arguments: args });
        expect((result as ToolText).isError).toBe(true);
        expect(parseText(result).error.code).toBe(code);
        expectNoHostPath(JSON.stringify(result), fixture);
      }
    });

    it('finds files by glob without denied entries', async () => {
      const found = parseText(await session.client.callTool({ name: 'find_files', arguments: { pattern: '**/*' } }));
      const paths = found.files.map((file: { path: string }) => file.path);
      expect(paths).toContain('src/index.ts');
      expect(paths).not.toContain('.env');
      expectNoHostPath(JSON.stringify(found), fixture);
    });

    it('searches text without denied files or content in the audit log', async () => {
      const found = parseText(await session.client.callTool({ name: 'search_text', arguments: { query: 'export' } }));
      expect(found.matches).toContainEqual({ path: 'src/index.ts', line: 1, column: 1, text: 'export {};' });
      expect(found).not.toHaveProperty('bytesRead');
      const secret = parseText(await session.client.callTool({ name: 'search_text', arguments: { query: 'SECRET' } }));
      expect(secret.matches).toEqual([]);
      expectNoHostPath(JSON.stringify(found), fixture);
      const audit = session
        .stderr()
        .split('\n')
        .filter((line) => line.includes('"search_text"'));
      expect(audit.at(-1)).not.toContain('SECRET');
      expect(JSON.parse(audit[0] ?? '{}')).toMatchObject({ tool: 'search_text', ok: true });
      expect(JSON.parse(audit[0] ?? '{}').bytes_read).toBeGreaterThan(0);

      const multiline = await session.client.callTool({ name: 'search_text', arguments: { query: 'a\nb' } });
      expect((multiline as ToolText).isError).toBe(true);
    });

    it('searches with an opt-in RE2 regex and rejects invalid patterns', async () => {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'search_text')?.inputSchema;
      expect(schema?.properties?.regex).toMatchObject({ type: 'boolean', default: false });
      expect(schema?.required ?? []).not.toContain('regex');

      const found = parseText(await session.client.callTool({ name: 'search_text', arguments: { query: '^exp\\w+ \\{\\};$', regex: true } }));
      expect(found.matches).toContainEqual({ path: 'src/index.ts', line: 1, column: 1, text: 'export {};' });
      const literal = parseText(await session.client.callTool({ name: 'search_text', arguments: { query: '^exp\\w+' } }));
      expect(literal.matches).toEqual([]);

      const invalid = await session.client.callTool({ name: 'search_text', arguments: { query: '(a', regex: true } });
      expect((invalid as ToolText).isError).toBe(true);
      expect(parseText(invalid).error.code).toBe('INVALID_PATH');
      expectNoHostPath(JSON.stringify(invalid), fixture);
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

  describe('multiple workspaces (WORKSPACE_ROOTS)', () => {
    let other: Fixture;
    let session: Awaited<ReturnType<typeof connect>>;
    const pathTools = ['edit_file', 'find_files', 'list_directory', 'multi_edit_file', 'read_file', 'search_text', 'write_file'];

    beforeAll(async () => {
      other = await createFixture();
      session = await connect({
        WORKSPACE_ROOTS: `api=${fixture.root},web=${other.root}`,
        WORKSPACE_MODE: 'read-write',
      });
    });

    afterAll(async () => {
      await session.client.close();
      await other.cleanup();
    });

    const call = (name: string, args: Record<string, unknown>) => session.client.callTool({ name, arguments: args });

    it('requires a workspace argument limited to the configured names', async () => {
      const { tools } = await session.client.listTools();
      for (const tool of tools) {
        if (!pathTools.includes(tool.name)) continue;
        expect(tool.inputSchema.required, tool.name).toContain('workspace');
        expect(tool.inputSchema.properties?.workspace, tool.name).toMatchObject({ enum: ['api', 'web'] });
      }
      const info = tools.find((tool) => tool.name === 'get_workspace_info');
      expect(info?.inputSchema.properties ?? {}).not.toHaveProperty('workspace');
      for (const name of ['write_file', 'edit_file', 'multi_edit_file']) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.description, name).toMatch(/Writable workspaces: api, web\.$/);
      }
    });

    it('lists the workspaces without host paths', async () => {
      const result = await call('get_workspace_info', {});
      const info = parseText(result);
      expect(info.workspaces).toEqual([
        { name: 'api', mode: 'read-write' },
        { name: 'web', mode: 'read-write' },
      ]);
      expect(info).not.toHaveProperty('root');
      expect(info).not.toHaveProperty('mode');
      expectNoHostPath(JSON.stringify(result), fixture);
      expectNoHostPath(JSON.stringify(result), other);
    });

    it('keeps each call inside the selected workspace', async () => {
      const created = parseText(await call('write_file', { workspace: 'web', path: 'only-web.txt', content: 'web\n' }));
      expect(created.created).toBe(true);
      expect(parseText(await call('read_file', { workspace: 'web', path: 'only-web.txt' })).content).toBe('web\n');

      const missing = await call('read_file', { workspace: 'api', path: 'only-web.txt' });
      expect(parseText(missing).error.code).toBe('FILE_NOT_FOUND');
      const found = parseText(await call('find_files', { workspace: 'api', pattern: '**/only-web.txt' }));
      expect(found.files).toEqual([]);
      const searched = parseText(await call('search_text', { workspace: 'api', query: 'web' }));
      expect(searched.matches).toEqual([]);
    });

    it('applies escape and deny checks per workspace without host paths', async () => {
      for (const workspace of ['api', 'web']) {
        for (const [args, code] of [
          [{ path: '../outside/private.txt' }, 'PATH_OUTSIDE_WORKSPACE'],
          [{ path: 'link-outside-file' }, 'PATH_OUTSIDE_WORKSPACE'],
          [{ path: '.env' }, 'PATH_BLOCKED'],
        ] as const) {
          const result = await call('read_file', { workspace, ...args });
          expect(parseText(result).error.code).toBe(code);
          expectNoHostPath(JSON.stringify(result), fixture);
          expectNoHostPath(JSON.stringify(result), other);
        }
      }
    });

    it.each([
      ['a missing workspace', { path: 'README.md' }],
      ['an unknown workspace', { workspace: 'nope', path: 'README.md' }],
    ])('rejects %s', async (_label, args) => {
      const result = await call('read_file', args);
      expect((result as ToolText).isError).toBe(true);
      expectNoHostPath(JSON.stringify(result), fixture);
      expectNoHostPath(JSON.stringify(result), other);
    });

    it('records the workspace in the audit log', async () => {
      await call('read_file', { workspace: 'api', path: 'src/index.ts' });
      const records = session
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      expect(records.find((record) => record.tool === 'read_file' && record.path === 'src/index.ts')).toMatchObject({
        workspace: 'api',
        ok: true,
      });
      expect(records.find((record) => record.tool === 'get_workspace_info')).not.toHaveProperty('workspace');
    });
  });

  describe('per-workspace mode (WORKSPACE_READ_WRITE)', () => {
    let other: Fixture;
    let session: Awaited<ReturnType<typeof connect>>;

    beforeAll(async () => {
      other = await createFixture();
      session = await connect({ WORKSPACE_ROOTS: `api=${fixture.root},web=${other.root}`, WORKSPACE_READ_WRITE: 'web' });
    });

    afterAll(async () => {
      await session.client.close();
      await other.cleanup();
    });

    const call = (name: string, args: Record<string, unknown>) => session.client.callTool({ name, arguments: args });
    const expectNoHostPaths = (result: unknown) => {
      expectNoHostPath(JSON.stringify(result), fixture);
      expectNoHostPath(JSON.stringify(result), other);
    };

    it('reports each workspace mode without a shared one', async () => {
      const result = await call('get_workspace_info', {});
      const info = parseText(result);
      expect(info.workspaces).toEqual([
        { name: 'api', mode: 'read-only' },
        { name: 'web', mode: 'read-write' },
      ]);
      expect(info).not.toHaveProperty('mode');
      expectNoHostPaths(result);
    });

    it('names the writable workspaces in the write tool descriptions', async () => {
      const { tools } = await session.client.listTools();
      for (const name of ['write_file', 'edit_file', 'multi_edit_file']) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.description, name).toContain('Writable workspaces: web.');
        expect(tool?.annotations?.destructiveHint, name).toBe(true);
      }
    });

    it('rejects writes to a read-only workspace and allows the writable one', async () => {
      const denied = await call('write_file', { workspace: 'api', path: 'new.txt', content: 'x' });
      expect(parseText(denied).error.code).toBe('READ_ONLY');
      expectNoHostPaths(denied);

      const read = parseText(await call('read_file', { workspace: 'api', path: 'README.md' }));
      const edit = await call('edit_file', {
        workspace: 'api',
        path: 'README.md',
        old_string: read.content.slice(0, 1),
        new_string: 'x',
        expected_revision: read.revision,
      });
      expect(parseText(edit).error.code).toBe('READ_ONLY');
      expectNoHostPaths(edit);

      const created = parseText(await call('write_file', { workspace: 'web', path: 'new.txt', content: 'web\n' }));
      expect(created.created).toBe(true);
      const edited = parseText(
        await call('edit_file', {
          workspace: 'web',
          path: 'new.txt',
          old_string: 'web',
          new_string: 'web2',
          expected_revision: created.revision,
        }),
      );
      expect(edited.replacements).toBe(1);
      expect(parseText(await call('read_file', { workspace: 'api', path: 'new.txt' })).error.code).toBe('FILE_NOT_FOUND');

      const multiDenied = await call('multi_edit_file', {
        workspace: 'api',
        path: 'README.md',
        edits: [{ old_string: read.content.slice(0, 1), new_string: 'x' }],
        expected_revision: read.revision,
      });
      expect(parseText(multiDenied).error.code).toBe('READ_ONLY');
      expectNoHostPaths(multiDenied);
      expect(parseText(await call('read_file', { workspace: 'api', path: 'README.md' })).revision).toBe(read.revision);

      const multi = parseText(
        await call('multi_edit_file', {
          workspace: 'web',
          path: 'new.txt',
          edits: [
            { old_string: 'web2', new_string: 'web3' },
            { old_string: 'web3', new_string: 'web4' },
          ],
          expected_revision: edited.revision,
        }),
      );
      expect(multi).toMatchObject({ replacements: 2, edit_replacements: [1, 1] });
      expect(parseText(await call('read_file', { workspace: 'web', path: 'new.txt' })).content).toBe('web4\n');
    });

    it('records the read-only workspace in the audit log', async () => {
      await call('write_file', { workspace: 'api', path: 'audit.txt', content: 'x' });
      const records = session
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      expect(records.find((record) => record.tool === 'write_file' && record.path === 'audit.txt')).toMatchObject({
        workspace: 'api',
        ok: false,
        error_code: 'READ_ONLY',
      });
    });
  });

  it('serves a 2026-07-28 (stateless) connection', async () => {
    const session = await connect({ WORKSPACE_ROOT: fixture.root }, { mode: { pin: '2026-07-28' } });
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const { tools } = await session.client.listTools();
      expect(tools).toHaveLength(8);
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
      // dry_run does not lift read-only mode (M49).
      const read = parseText(await session.client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }));
      for (const [name, args] of [
        ['edit_file', { old_string: 'readme', new_string: 'x' }],
        ['multi_edit_file', { edits: [{ old_string: 'readme', new_string: 'x' }] }],
      ] as const) {
        const preview = await session.client.callTool({
          name,
          arguments: { path: 'README.md', expected_revision: read.revision, dry_run: true, ...args },
        });
        expect(parseText(preview).error.code, name).toBe('READ_ONLY');
      }
    } finally {
      await session.client.close();
    }
  });

  describe('CLI flags', () => {
    it('--check validates a single workspace and prints the summary to stderr only', async () => {
      const auditLog = path.join(fixture.outside, 'check-audit.jsonl');
      const result = await runCli(['--check'], {
        WORKSPACE_ROOT: fixture.root,
        WORKSPACE_MODE: 'read-write',
        WORKSPACE_MAX_DEPTH: '2',
        WORKSPACE_AUDIT_LOG: auditLog,
        WORKSPACE_EXTRA_DENY_PATTERNS: 'README*',
      });
      expect(result).toMatchObject({ code: 0, stdout: '' });
      const lines = result.stderr.trimEnd().split('\n');
      expect(lines[0]).toMatch(/^private-workspace-mcp \S+: configuration OK \(WORKSPACE_ROOT\)$/);
      expect(lines).toContain(`workspace "workspace" read-write ${await realpath(fixture.root)}`);
      expect(result.stderr).toContain('max_depth=2');
      expect(lines).toContain(`audit: file ${path.join(await realpath(fixture.outside), 'check-audit.jsonl')} (rotate at 10485760 bytes)`);
      expect(result.stderr).toMatch(/^deny: \d+ default patterns, extra: README\*$/m);
      expect(result.stderr).not.toContain('listening on stdio');
      // Checking must not create the audit file.
      await expect(stat(auditLog)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('--check lists every workspace with its own mode', async () => {
      const other = await createFixture();
      try {
        const result = await runCli(['--check'], {
          WORKSPACE_ROOTS: `api=${fixture.root},web=${other.root}`,
          WORKSPACE_READ_WRITE: 'web',
        });
        expect(result).toMatchObject({ code: 0, stdout: '' });
        const lines = result.stderr.trimEnd().split('\n');
        expect(lines[0]).toMatch(/configuration OK \(WORKSPACE_ROOTS\)$/);
        expect(lines).toContain(`workspace "api" read-only ${await realpath(fixture.root)}`);
        expect(lines).toContain(`workspace "web" read-write ${await realpath(other.root)}`);
        expect(lines).toContain('audit: stderr');
        expect(result.stderr).toMatch(/^deny: \d+ default patterns$/m);
      } finally {
        await other.cleanup();
      }
    });

    it('--check fails with the same message as startup on invalid configuration', async () => {
      const env = { WORKSPACE_ROOT: fixture.root, WORKSPACE_READ_WRITE: 'web' };
      const checked = await runCli(['--check'], env);
      const started = await runCli([], env);
      expect(checked).toMatchObject({ code: 1, stdout: '' });
      expect(started).toMatchObject({ code: 1, stdout: '' });
      expect(checked.stderr).toBe(started.stderr);
      expect(checked.stderr).toBe('private-workspace-mcp: invalid configuration: WORKSPACE_READ_WRITE requires WORKSPACE_ROOTS; use WORKSPACE_MODE with WORKSPACE_ROOT\n');
    });

    it('--version prints the package.json version without reading configuration', async () => {
      const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
      const result = await runCli(['--version']);
      expect(result).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
    });

    it.each([
      ['an unknown flag', ['--nope']],
      ['a positional argument', ['serve']],
      ['a value on a boolean flag', ['--check=yes']],
      ['conflicting flags', ['--check', '--version']],
    ])('rejects %s with usage and exit 2', async (_label, args) => {
      const result = await runCli(args, { WORKSPACE_ROOT: fixture.root });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Usage: private-workspace-mcp [--check | --version]');
      expect(result.stderr).not.toContain('listening on stdio');
    });
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
