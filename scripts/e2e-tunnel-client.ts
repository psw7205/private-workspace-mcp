/**
 * End-to-end check through the real OpenAI tunnel-client binary:
 *
 *   MCP client --HTTP--> tunnel-client dev proxy (local control plane) --stdio--> dist/index.js
 *
 * Requires `tunnel-client` on PATH and a prior `pnpm build`. No OpenAI credentials are needed:
 * `dev proxy` runs the control plane in-process. Run with `pnpm e2e:tunnel`. Set
 * TEST_SERVER_ENTRY (e.g. release/index.mjs) to exercise a built artifact instead of dist/index.js.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.resolve(projectRoot, process.env.TEST_SERVER_ENTRY ?? 'dist/index.js');

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startProxy(workspaceEnv: Record<string, string>, scratch: string, name: string) {
  const urlFile = path.join(scratch, `${name}.json`);
  let stderr = '';
  const proxy = spawn(
    'tunnel-client',
    ['dev', 'proxy', '--mcp-command', `${process.execPath} ${serverEntry}`, '--url-file', urlFile],
    {
      // Drop inherited WORKSPACE_* so each case runs with exactly the settings it names.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WORKSPACE_'))), ...workspaceEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  proxy.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  const { mcp_url: mcpUrl } = await waitFor('proxy url file', async () =>
    JSON.parse(await readFile(urlFile, 'utf8')) as { mcp_url: string },
  );
  const childPid = await waitFor('stdio MCP child', async () => {
    const out = execFileSync('pgrep', ['-P', String(proxy.pid), '-f', serverEntry], { encoding: 'utf8' }).trim();
    return out ? Number(out.split('\n')[0]) : undefined;
  });
  return { proxy, mcpUrl, childPid, stderr: () => stderr };
}

function text(result: unknown): any {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? 'null');
}

async function exercise(mcpUrl: string, versionNegotiation: ClientOptions['versionNegotiation'], label: string) {
  const client = new Client({ name: 'pwmcp-e2e', version: '0.0.0' }, versionNegotiation ? { versionNegotiation } : undefined);
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  log(`${label}: connected, era=${client.getProtocolEra()} version=${client.getNegotiatedProtocolVersion()}`);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['edit_file', 'find_files', 'get_workspace_info', 'list_directory', 'multi_edit_file', 'read_file', 'search_text', 'write_file']);
  log(`${label}: tools/list -> ${tools.map((tool) => tool.name).join(', ')}`);

  const info = text(await client.callTool({ name: 'get_workspace_info', arguments: {} }));
  assert.equal(info.mode, 'read-write');
  assert.equal(info.root, '.');

  const listing = text(await client.callTool({ name: 'list_directory', arguments: { path: '.' } }));
  const names = listing.entries.map((entry: { path: string }) => entry.path);
  assert.ok(names.includes('README.md'));
  assert.ok(!names.includes('.env'), '.env must be hidden');

  const read = text(await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }));
  const file = `notes-${label}.md`;
  const created = text(await client.callTool({ name: 'write_file', arguments: { path: `docs/${file}`, content: `# ${label}\n` } }));
  assert.equal(created.created, true);
  const updated = text(
    await client.callTool({
      name: 'write_file',
      arguments: { path: `docs/${file}`, content: `# ${label} v2\n`, expected_revision: created.revision },
    }),
  );
  assert.equal(updated.created, false);
  const stale = await client.callTool({
    name: 'write_file',
    arguments: { path: `docs/${file}`, content: 'stale', expected_revision: created.revision },
  });
  assert.equal(text(stale).error.code, 'REVISION_CONFLICT');
  log(`${label}: read revision ${String(read.revision).slice(0, 19)}..., create/update ok, stale write -> REVISION_CONFLICT`);

  for (const [target, code] of [
    ['../outside.txt', 'PATH_OUTSIDE_WORKSPACE'],
    ['escape/private.txt', 'PATH_OUTSIDE_WORKSPACE'],
    ['.env', 'PATH_BLOCKED'],
  ] as const) {
    const result = await client.callTool({ name: 'read_file', arguments: { path: target } });
    assert.equal(text(result).error.code, code);
  }
  log(`${label}: escape and deny cases rejected`);
  await client.close();
}

/**
 * WORKSPACE_ROOTS (ADR-008): one tunnel-client child serves both workspaces, selected per call.
 * Started with WORKSPACE_READ_WRITE=web, so only `web` accepts writes.
 */
async function exerciseMulti(mcpUrl: string): Promise<void> {
  const client = new Client({ name: 'pwmcp-e2e', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const { tools } = await client.listTools();
  const read = tools.find((tool) => tool.name === 'read_file');
  assert.deepEqual((read?.inputSchema.properties?.workspace as { enum?: string[] } | undefined)?.enum, ['api', 'web']);
  const info = text(await client.callTool({ name: 'get_workspace_info', arguments: {} }));
  assert.deepEqual(info.workspaces, [
    { name: 'api', mode: 'read-only' },
    { name: 'web', mode: 'read-write' },
  ]);
  assert.equal(info.mode, undefined);
  const write = tools.find((tool) => tool.name === 'write_file');
  assert.match(write?.description ?? '', /Writable workspaces: web\./);

  const created = text(
    await client.callTool({ name: 'write_file', arguments: { workspace: 'web', path: 'only-web.md', content: '# web\n' } }),
  );
  assert.equal(created.created, true);
  const denied = await client.callTool({ name: 'write_file', arguments: { workspace: 'api', path: 'only-web.md', content: '# api\n' } });
  assert.equal(text(denied).error.code, 'READ_ONLY');
  const multiDenied = await client.callTool({
    name: 'multi_edit_file',
    arguments: { workspace: 'api', path: 'README.md', edits: [{ old_string: '#', new_string: '##' }], expected_revision: 'sha256:0' },
  });
  assert.equal(text(multiDenied).error.code, 'READ_ONLY');
  const multiEdited = text(
    await client.callTool({
      name: 'multi_edit_file',
      arguments: {
        workspace: 'web',
        path: 'only-web.md',
        edits: [
          { old_string: 'web', new_string: 'web2' },
          { old_string: '# web2', new_string: '## web2' },
        ],
        expected_revision: created.revision,
      },
    }),
  );
  assert.deepEqual(multiEdited.edit_replacements, [1, 1]);
  const missing = await client.callTool({ name: 'read_file', arguments: { workspace: 'api', path: 'only-web.md' } });
  assert.equal(text(missing).error.code, 'FILE_NOT_FOUND');
  for (const workspace of ['api', 'web']) {
    const escaped = await client.callTool({ name: 'read_file', arguments: { workspace, path: '../outside/private.txt' } });
    assert.equal(text(escaped).error.code, 'PATH_OUTSIDE_WORKSPACE');
  }
  const unknown = await client.callTool({ name: 'read_file', arguments: { workspace: 'nope', path: 'README.md' } });
  assert.equal((unknown as { isError?: boolean }).isError, true);
  log('multi: workspace enum, per-workspace mode (api READ_ONLY, web writable, write_file and multi_edit_file), isolation, escape and unknown workspace rejected');
  await client.close();
}

/** WORKSPACE_GIT=read-only (ADR-004) on a real repository: the four Git tools through the tunnel. */
async function exerciseGit(mcpUrl: string): Promise<void> {
  const client = new Client({ name: 'pwmcp-e2e', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const { tools } = await client.listTools();
  for (const name of ['git_diff', 'git_log', 'git_show', 'git_status']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, true, name);
  }
  assert.equal(text(await client.callTool({ name: 'get_workspace_info', arguments: {} })).git, true);

  const status = text(await client.callTool({ name: 'git_status', arguments: {} }));
  assert.equal(status.branch, 'main');
  assert.deepEqual(status.entries, [{ path: 'README.md', index: '.', worktree: 'M' }], 'modified .env must be hidden');
  const history = text(await client.callTool({ name: 'git_log', arguments: {} }));
  assert.deepEqual(history.commits.map((commit: { message: string }) => commit.message), ['second', 'initial']);
  const show = text(await client.callTool({ name: 'git_show', arguments: { rev: 'HEAD~1' } }));
  assert.deepEqual(show.files.map((file: { path: string }) => file.path), ['README.md']);
  assert.ok(!JSON.stringify(show).includes('SECRET'), 'committed .env must be hidden');
  const diff = text(await client.callTool({ name: 'git_diff', arguments: {} }));
  assert.match(diff.patch, /\+# e2e v3/);
  const stash = await client.callTool({ name: 'git_show', arguments: { rev: 'stash^3' } });
  assert.equal(text(stash).error.code, 'INVALID_REVISION');
  log(`git: status, log, show, diff ok; .env hidden in status and history; stash^3 -> INVALID_REVISION`);
  await client.close();
}

async function stopAndCheckChild(proxy: ChildProcess, childPid: number, signal: NodeJS.Signals): Promise<void> {
  assert.ok(isAlive(childPid));
  proxy.kill(signal);
  await waitFor(`child exit after tunnel-client ${signal}`, async () => (isAlive(childPid) ? undefined : true), 10_000);
  log(`tunnel-client ${signal} -> MCP child ${childPid} exited`);
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pwmcp-e2e-'));
  const workspace = path.join(scratch, 'workspace');
  const outside = path.join(scratch, 'outside');
  const web = path.join(scratch, 'web');
  await mkdir(workspace);
  await mkdir(web);
  await mkdir(outside);
  await writeFile(path.join(workspace, 'README.md'), '# e2e\n');
  await writeFile(path.join(workspace, '.env'), 'SECRET=1\n');
  await writeFile(path.join(outside, 'private.txt'), 'outside\n');
  execFileSync('ln', ['-s', outside, path.join(workspace, 'escape')]);

  const proxies: ChildProcess[] = [];
  try {
    // serveStdio pins the stdio connection to the era of its first request, and tunnel-client
    // multiplexes all callers onto one child, so each era gets its own tunnel-client here.
    const legacy = await startProxy({ WORKSPACE_ROOT: workspace, WORKSPACE_MODE: 'read-write' }, scratch, 'legacy');
    proxies.push(legacy.proxy);
    log(`tunnel-client dev proxy up at ${legacy.mcpUrl}, MCP child pid ${legacy.childPid}`);
    await exercise(legacy.mcpUrl, undefined, 'legacy');
    assert.match(legacy.stderr(), /"event":"tool_call"/, 'audit records reach tunnel-client stderr');
    assert.ok(!legacy.stderr().includes('SECRET=1'), 'file content must not be logged');
    await stopAndCheckChild(legacy.proxy, legacy.childPid, 'SIGTERM');

    const modern = await startProxy({ WORKSPACE_ROOT: workspace, WORKSPACE_MODE: 'read-write' }, scratch, 'modern');
    proxies.push(modern.proxy);
    await exercise(modern.mcpUrl, { mode: { pin: '2026-07-28' } }, 'modern');
    await stopAndCheckChild(modern.proxy, modern.childPid, 'SIGKILL');

    const multi = await startProxy({ WORKSPACE_ROOTS: `api=${workspace},web=${web}`, WORKSPACE_READ_WRITE: 'web' }, scratch, 'multi');
    proxies.push(multi.proxy);
    await exerciseMulti(multi.mcpUrl);
    assert.match(multi.stderr(), /"workspace":"web"/, 'audit records name the workspace');
    assert.match(multi.stderr(), /"workspace":"api"[^\n]*"error_code":"READ_ONLY"/, 'audit records the read-only rejection');
    await stopAndCheckChild(multi.proxy, multi.childPid, 'SIGTERM');

    const repo = path.join(scratch, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), '# e2e\n');
    await writeFile(path.join(repo, '.env'), 'SECRET=1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    await writeFile(path.join(repo, 'README.md'), '# e2e v2\n');
    git('commit', '-q', '-am', 'second');
    await writeFile(path.join(repo, 'README.md'), '# e2e v3\n');
    await writeFile(path.join(repo, '.env'), 'SECRET=2\n');
    // A runtime key in the tunnel-client environment must not matter to the Git tools (ADR-004 §2.3).
    const gitProxy = await startProxy({ WORKSPACE_ROOT: repo, WORKSPACE_GIT: 'read-only', CONTROL_PLANE_API_KEY: 'e2e-not-a-key' }, scratch, 'git');
    proxies.push(gitProxy.proxy);
    await exerciseGit(gitProxy.mcpUrl);
    assert.match(gitProxy.stderr(), /"tool":"git_log"[^\n]*"ok":true/, 'git calls are audited');
    assert.ok(!gitProxy.stderr().includes('SECRET'), 'git output must not be logged');
    await stopAndCheckChild(gitProxy.proxy, gitProxy.childPid, 'SIGTERM');

    assert.deepEqual(execFileSync('ls', [outside], { encoding: 'utf8' }).trim().split('\n'), ['private.txt']);
    log('PASS');
  } finally {
    for (const proxy of proxies) proxy.kill('SIGKILL');
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('[e2e] FAIL', error);
  process.exitCode = 1;
});
