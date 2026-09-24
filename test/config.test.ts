import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
      workspaces: [{ name: 'my-project', root: await realpath(workspace) }],
      multi: false,
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
    expect(config.workspaces).toEqual([{ name: 'my-project', root: await realpath(workspace) }]);
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
    expect(config.workspaces[0]?.name).toBe('alias');
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

  describe('broad roots', () => {
    it.each([
      ['the filesystem root', () => path.parse(process.cwd()).root],
      ['the home directory', () => os.homedir()],
      ['a parent of the home directory', () => path.dirname(os.homedir())],
    ])('rejects %s', async (_label, root) => {
      await expect(loadConfig({ WORKSPACE_ROOT: root() })).rejects.toThrow(/WORKSPACE_ROOT/);
    });

    it('still rejects the filesystem root when the home directory is unknown', async () => {
      // os.homedir() throws on Linux when HOME is unset and the uid has no passwd entry.
      const spy = vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('ENOENT: uv_os_homedir');
      });
      try {
        await expect(loadConfig({ WORKSPACE_ROOT: path.parse(process.cwd()).root })).rejects.toThrow(/WORKSPACE_ROOT/);
        await expect(loadConfig({ WORKSPACE_ROOT: workspace })).resolves.toMatchObject({
          workspaces: [{ root: await realpath(workspace) }],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('WORKSPACE_ROOTS', () => {
    let api: string;
    let web: string;

    beforeAll(async () => {
      api = path.join(base, 'api');
      web = path.join(base, 'web');
      await mkdir(path.join(api, 'nested'), { recursive: true });
      await mkdir(web);
      await symlink(api, path.join(base, 'api-link'), 'dir');
    });

    it('configures named canonical roots that tools select by name', async () => {
      const config = await loadConfig({ WORKSPACE_ROOTS: ` api=${api} , web_2=${path.join(base, 'workspace-link')} ` });
      expect(config.multi).toBe(true);
      expect(config.workspaces).toEqual([
        { name: 'api', root: await realpath(api) },
        { name: 'web_2', root: await realpath(workspace) },
      ]);
      expect(config.mode).toBe('read-only');
    });

    it('keeps the argument even for a single entry', async () => {
      const config = await loadConfig({ WORKSPACE_ROOTS: `api=${api}` });
      expect(config).toMatchObject({ multi: true, workspaces: [{ name: 'api' }] });
    });

    it('splits each entry at the first "="', async () => {
      const odd = path.join(base, 'a=b');
      await mkdir(odd, { recursive: true });
      const config = await loadConfig({ WORKSPACE_ROOTS: `odd=${odd}` });
      expect(config.workspaces).toEqual([{ name: 'odd', root: await realpath(odd) }]);
    });

    it.each([
      ['an empty list', () => ','],
      ['an entry without "="', () => `${api}`],
      ['an empty name', () => `=${api}`],
      ['an uppercase name', () => `Api=${api}`],
      ['a name with a dot', () => `a.b=${api}`],
      ['a name starting with "-"', () => `-api=${api}`],
      ['a name over 64 characters', () => `${'a'.repeat(65)}=${api}`],
      ['a duplicate name', () => `api=${api},api=${web}`],
      ['a relative root', () => 'api=relative/path'],
      ['a missing root', () => 'api=/nonexistent/pwmcp-root'],
      ['a root that is a file', () => `api=${path.join(base, 'file.txt')}`],
      ['the home directory', () => `api=${api},home=${os.homedir()}`],
      ['the same root twice', () => `api=${api},again=${api}`],
      ['the same root through a symlink', () => `api=${api},alias=${path.join(base, 'api-link')}`],
      ['a root inside another', () => `api=${api},nested=${path.join(api, 'nested')}`],
      ['a root containing another', () => `nested=${path.join(api, 'nested')},parent=${base}`],
    ])('rejects %s', async (_label, roots) => {
      await expect(loadConfig({ WORKSPACE_ROOTS: roots() })).rejects.toThrow(/WORKSPACE_ROOTS/);
    });

    it.each([
      ['WORKSPACE_ROOT', () => ({ WORKSPACE_ROOT: workspace })],
      ['WORKSPACE_NAME', () => ({ WORKSPACE_NAME: 'alias' })],
    ])('refuses to combine with %s', async (_label, extra) => {
      await expect(loadConfig({ WORKSPACE_ROOTS: `api=${api}`, ...extra() })).rejects.toThrow(/WORKSPACE_ROOTS/);
    });

    it('requires the audit log outside every root', async () => {
      await expect(
        loadConfig({ WORKSPACE_ROOTS: `api=${api},web=${web}`, WORKSPACE_AUDIT_LOG: path.join(web, 'audit.jsonl') }),
      ).rejects.toThrow(/WORKSPACE_AUDIT_LOG/);
      await expect(
        loadConfig({ WORKSPACE_ROOTS: `api=${api},web=${web}`, WORKSPACE_AUDIT_LOG: path.join(base, 'audit.jsonl') }),
      ).resolves.toMatchObject({ audit: { path: path.join(await realpath(base), 'audit.jsonl') } });
    });
  });

  it('rejects a root that is a file', async () => {
    await expect(loadConfig({ WORKSPACE_ROOT: path.join(base, 'file.txt') })).rejects.toThrow();
  });
});
