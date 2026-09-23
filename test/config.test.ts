import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { DEFAULT_DENY_PATTERNS } from '../src/policy/deny-list.js';

describe('loadConfig', () => {
  let base: string;
  let workspace: string;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'pwmcp-config-'));
    workspace = path.join(base, 'my-project');
    await mkdir(workspace);
    await writeFile(path.join(base, 'file.txt'), 'x');
    await symlink(workspace, path.join(base, 'workspace-link'), 'dir');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('defaults to read-only with documented limits', async () => {
    const config = await loadConfig({ WORKSPACE_ROOT: workspace });
    expect(config).toEqual({
      root: await realpath(workspace),
      name: 'my-project',
      mode: 'read-only',
      limits: {
        maxReadBytes: 1_048_576,
        maxWriteBytes: 1_048_576,
        maxDirectoryEntries: 1000,
        maxDepth: 3,
        requestTimeoutMs: 10_000,
        maxSearchFiles: 10_000,
      },
      audit: { maxBytes: 10_485_760 },
      denyPatterns: [...DEFAULT_DENY_PATTERNS],
    });
  });

  it('appends extra deny patterns to the defaults', async () => {
    const config = await loadConfig({ WORKSPACE_ROOT: workspace, WORKSPACE_EXTRA_DENY_PATTERNS: ' *.sqlite , private ' });
    expect(config.denyPatterns).toEqual([...DEFAULT_DENY_PATTERNS, '*.sqlite', 'private']);
  });

  it.each(['a/b', 'a\\b', '*.db,', ',', 'bad\u0001name'])('rejects extra deny pattern list %j', async (patterns) => {
    await expect(loadConfig({ WORKSPACE_ROOT: workspace, WORKSPACE_EXTRA_DENY_PATTERNS: patterns })).rejects.toThrow();
  });

  it('canonicalizes a symlinked root', async () => {
    const config = await loadConfig({ WORKSPACE_ROOT: path.join(base, 'workspace-link') });
    expect(config.root).toBe(await realpath(workspace));
  });

  it('reads explicit mode, name, and limits', async () => {
    const config = await loadConfig({
      WORKSPACE_ROOT: workspace,
      WORKSPACE_MODE: 'read-write',
      WORKSPACE_NAME: 'alias',
      WORKSPACE_MAX_READ_BYTES: '10',
      WORKSPACE_MAX_WRITE_BYTES: '20',
      WORKSPACE_MAX_DIRECTORY_ENTRIES: '30',
      WORKSPACE_MAX_DEPTH: '2',
      WORKSPACE_REQUEST_TIMEOUT_MS: '500',
      WORKSPACE_MAX_SEARCH_FILES: '40',
    });
    expect(config.mode).toBe('read-write');
    expect(config.name).toBe('alias');
    expect(config.limits).toEqual({
      maxReadBytes: 10,
      maxWriteBytes: 20,
      maxDirectoryEntries: 30,
      maxDepth: 2,
      requestTimeoutMs: 500,
      maxSearchFiles: 40,
    });
  });

  it('accepts the largest timeout a timer can hold', async () => {
    const config = await loadConfig({ WORKSPACE_ROOT: workspace, WORKSPACE_REQUEST_TIMEOUT_MS: '2147483647' });
    expect(config.limits.requestTimeoutMs).toBe(2_147_483_647);
  });

  it.each([
    ['missing root', {}],
    ['relative root', { WORKSPACE_ROOT: 'relative/path' }],
    ['nonexistent root', { WORKSPACE_ROOT: '/nonexistent/pwmcp-root' }],
    ['unknown mode', { WORKSPACE_MODE: 'rw' }],
    ['non-numeric limit', { WORKSPACE_MAX_READ_BYTES: 'lots' }],
    ['zero limit', { WORKSPACE_MAX_DEPTH: '0' }],
    ['fractional limit', { WORKSPACE_MAX_DIRECTORY_ENTRIES: '1.5' }],
    // setTimeout clamps larger delays to 1 ms, which would time out every call.
    ['timeout beyond the timer range', { WORKSPACE_REQUEST_TIMEOUT_MS: '2147483648' }],
    ['limit beyond the safe integer range', { WORKSPACE_MAX_READ_BYTES: '9007199254740992' }],
    ['audit size beyond the safe integer range', { WORKSPACE_AUDIT_LOG_MAX_BYTES: '9'.repeat(400) }],
  ])('fails closed on %s', async (_label, env: Record<string, string>) => {
    const withRoot = 'WORKSPACE_ROOT' in env || _label === 'missing root' ? env : { WORKSPACE_ROOT: workspace, ...env };
    await expect(loadConfig(withRoot)).rejects.toThrow();
  });

  describe('audit log', () => {
    it('accepts an absolute path outside the workspace', async () => {
      const config = await loadConfig({
        WORKSPACE_ROOT: workspace,
        WORKSPACE_AUDIT_LOG: path.join(base, 'audit.jsonl'),
        WORKSPACE_AUDIT_LOG_MAX_BYTES: '2048',
      });
      expect(config.audit).toEqual({ path: path.join(await realpath(base), 'audit.jsonl'), maxBytes: 2048 });
    });

    it.each([
      ['a relative path', () => 'audit.jsonl'],
      ['a path inside the workspace', () => path.join(workspace, 'audit.jsonl')],
      ['a path inside the workspace via a symlinked parent', () => path.join(base, 'workspace-link', 'audit.jsonl')],
      ['a missing parent directory', () => path.join(base, 'missing', 'audit.jsonl')],
      ['a symlink', () => path.join(base, 'audit-link.jsonl')],
      ['a directory', () => base],
    ])('rejects %s', async (_label, audit) => {
      await symlink(path.join(base, 'file.txt'), path.join(base, 'audit-link.jsonl')).catch(() => undefined);
      await expect(loadConfig({ WORKSPACE_ROOT: workspace, WORKSPACE_AUDIT_LOG: audit() })).rejects.toThrow();
    });
  });

  it('rejects a root that is a file', async () => {
    await expect(loadConfig({ WORKSPACE_ROOT: path.join(base, 'file.txt') })).rejects.toThrow();
  });
});
