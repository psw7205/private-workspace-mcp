import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listDirectory } from '../src/filesystem/directory-lister.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { createDenyMatcher, DEFAULT_DENY_PATTERNS } from '../src/policy/deny-list.js';
import { createFixture, expectWorkspaceError, type Fixture } from './helpers.js';

describe('listDirectory', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    await mkdir(path.join(fixture.root, 'src/deep/deeper'), { recursive: true });
    await writeFile(path.join(fixture.root, 'src/deep/deeper/leaf.txt'), 'leaf');
    await writeFile(path.join(fixture.root, 'src/server.pem'), 'cert');
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(fixture.root, 'src/pipe')]);
    }
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('lists immediate children by default, hiding denied entries', async () => {
    const result = await listDirectory(guard, { path: '.', depth: 1, limit: 100 });
    expect(result).toEqual({
      path: '.',
      entries: [
        { path: 'README.md', type: 'file', size: 9 },
        { path: 'link-dangling', type: 'symlink' },
        { path: 'link-inside-dir', type: 'symlink' },
        { path: 'link-inside-file', type: 'symlink' },
        { path: 'link-outside-dir', type: 'symlink' },
        { path: 'link-outside-file', type: 'symlink' },
        { path: 'link-parent', type: 'symlink' },
        { path: 'link-to-env', type: 'symlink' },
        { path: 'src', type: 'directory' },
      ],
      truncated: false,
    });
  });

  it('recurses up to the requested depth without following symlinks', async () => {
    const result = await listDirectory(guard, { path: '.', depth: 3, limit: 100 });
    const paths = result.entries.map((entry) => entry.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/deep/deeper');
    expect(paths).not.toContain('src/deep/deeper/leaf.txt');
    expect(paths.some((entry) => entry.startsWith('link-inside-dir/'))).toBe(false);
    expect(paths.some((entry) => entry.startsWith('link-outside-dir/'))).toBe(false);
  });

  it('omits denied and special files in nested directories', async () => {
    const result = await listDirectory(guard, { path: 'src', depth: 1, limit: 100 });
    expect(result.entries).toEqual([
      { path: 'src/deep', type: 'directory' },
      { path: 'src/index.ts', type: 'file', size: 11 },
    ]);
  });

  it('omits entries matching the guard\'s extra deny patterns', async () => {
    const strict = new PathGuard(fixture.realRoot, createDenyMatcher([...DEFAULT_DENY_PATTERNS, 'index.ts']));
    const result = await listDirectory(strict, { path: 'src', depth: 1, limit: 100 });
    expect(result.entries.map((entry) => entry.path)).toEqual(['src/deep']);
  });

  it('truncates at the entry limit', async () => {
    const result = await listDirectory(guard, { path: '.', depth: 3, limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('lists a symlinked directory that stays inside under the requested path', async () => {
    const result = await listDirectory(guard, { path: 'link-inside-dir', depth: 1, limit: 100 });
    expect(result.entries.map((entry) => entry.path)).toEqual(['link-inside-dir/deep', 'link-inside-dir/index.ts']);
  });

  it('rejects a file', async () => {
    await expectWorkspaceError(listDirectory(guard, { path: 'README.md', depth: 1, limit: 10 }), 'NOT_A_DIRECTORY');
  });

  it('blocks symlink escape', async () => {
    await expectWorkspaceError(
      listDirectory(guard, { path: 'link-outside-dir', depth: 1, limit: 10 }),
      'PATH_OUTSIDE_WORKSPACE',
    );
  });

  it('blocks a denied directory', async () => {
    await expectWorkspaceError(listDirectory(guard, { path: '.git', depth: 1, limit: 10 }), 'PATH_BLOCKED');
  });
});
