/**
 * End-to-end check through the real OpenAI tunnel-client binary:
 *
 *   MCP client --HTTP--> tunnel-client dev proxy (local control plane) --stdio--> dist/index.js
 *
 * Requires `tunnel-client` on PATH and a prior `pnpm build`. No OpenAI credentials are needed:
 * `dev proxy` runs the control plane in-process. Run with `pnpm e2e:tunnel`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'dist/index.js');

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

async function startProxy(workspace: string, scratch: string, name: string) {
  const urlFile = path.join(scratch, `${name}.json`);
  let stderr = '';
  const proxy = spawn(
    'tunnel-client',
    ['dev', 'proxy', '--mcp-command', `${process.execPath} ${serverEntry}`, '--url-file', urlFile],
    {
      env: { ...process.env, WORKSPACE_ROOT: workspace, WORKSPACE_MODE: 'read-write' },
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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['edit_file', 'get_workspace_info', 'list_directory', 'read_file', 'write_file']);
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
    ['escape/secret.txt', 'PATH_OUTSIDE_WORKSPACE'],
    ['.env', 'PATH_BLOCKED'],
  ] as const) {
    const result = await client.callTool({ name: 'read_file', arguments: { path: target } });
    assert.equal(text(result).error.code, code);
  }
  log(`${label}: escape and deny cases rejected`);
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
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(workspace, 'README.md'), '# e2e\n');
  await writeFile(path.join(workspace, '.env'), 'SECRET=1\n');
  await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
  execFileSync('ln', ['-s', outside, path.join(workspace, 'escape')]);

  const proxies: ChildProcess[] = [];
  try {
    // serveStdio pins the stdio connection to the era of its first request, and tunnel-client
    // multiplexes all callers onto one child, so each era gets its own tunnel-client here.
    const legacy = await startProxy(workspace, scratch, 'legacy');
    proxies.push(legacy.proxy);
    log(`tunnel-client dev proxy up at ${legacy.mcpUrl}, MCP child pid ${legacy.childPid}`);
    await exercise(legacy.mcpUrl, undefined, 'legacy');
    assert.match(legacy.stderr(), /"event":"tool_call"/, 'audit records reach tunnel-client stderr');
    assert.ok(!legacy.stderr().includes('SECRET=1'), 'file content must not be logged');
    await stopAndCheckChild(legacy.proxy, legacy.childPid, 'SIGTERM');

    const modern = await startProxy(workspace, scratch, 'modern');
    proxies.push(modern.proxy);
    await exercise(modern.mcpUrl, { mode: { pin: '2026-07-28' } }, 'modern');
    await stopAndCheckChild(modern.proxy, modern.childPid, 'SIGKILL');

    assert.deepEqual(execFileSync('ls', [outside], { encoding: 'utf8' }).trim().split('\n'), ['secret.txt']);
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
