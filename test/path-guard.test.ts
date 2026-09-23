import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ErrorCode } from '../src/errors/errors.js';
import { normalizeRelativePath, PathGuard, relativeInside } from '../src/filesystem/path-guard.js';
import { createDenyMatcher, DEFAULT_DENY_PATTERNS } from '../src/policy/deny-list.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, type Fixture } from './helpers.js';

describe('relativeInside', () => {
  const root = path.resolve('workspace');

  it.each([
    ['the root itself', root, '.'],
    ['a nested path', path.join(root, 'src', 'a.ts'), 'src/a.ts'],
    ['a name that starts with ".."', path.join(root, '..foo'), '..foo'],
  ])('returns the relative form of %s', (_label, candidate, expected) => {
    expect(relativeInside(root, candidate)).toBe(expected);
  });

  it.each([
    ['the parent', path.dirname(root)],
    ['a sibling sharing the root as a string prefix', `${root}-other`],
    ['a path under a sibling', path.join(`${root}-other`, 'a.ts')],
  ])('rejects %s', (_label, candidate) => {
    expect(relativeInside(root, candidate)).toBeUndefined();
  });
});

describe('normalizeRelativePath', () => {
  it.each([
    ['.', '.'],
    ['./', '.'],
    ['src/index.ts', 'src/index.ts'],
    ['src/', 'src'],
    ['./src//nested/./file.md', 'src/nested/file.md'],
    // No URL decoding: these stay literal names inside the workspace.
    ['%2e%2e/x', '%2e%2e/x'],
    ['~/x', '~/x'],
    // Reserved-name check applies to the stem only, so similar names pass.
    ['CONFIG.md', 'CONFIG.md'],
    ['console.log', 'console.log'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeRelativePath(input)).toBe(expected);
  });

  it.each<[string, ErrorCode]>([
    ['', 'INVALID_PATH'],
    ['/etc/passwd', 'PATH_OUTSIDE_WORKSPACE'],
    ['C:\\Users\\x', 'PATH_OUTSIDE_WORKSPACE'],
    ['C:relative', 'PATH_OUTSIDE_WORKSPACE'],
    ['c:/x', 'PATH_OUTSIDE_WORKSPACE'],
    ['\\\\server\\share', 'PATH_OUTSIDE_WORKSPACE'],
    ['\\rooted', 'PATH_OUTSIDE_WORKSPACE'],
    ['..', 'PATH_OUTSIDE_WORKSPACE'],
    ['../secret', 'PATH_OUTSIDE_WORKSPACE'],
    ['../../secret', 'PATH_OUTSIDE_WORKSPACE'],
    ['src/../..', 'PATH_OUTSIDE_WORKSPACE'],
    ['src/../README.md', 'PATH_OUTSIDE_WORKSPACE'],
    ['a\\b', 'INVALID_PATH'],
    ['a\0b', 'INVALID_PATH'],
    ['a\nb', 'INVALID_PATH'],
    ['a\u007fb', 'INVALID_PATH'],
    ['CON', 'INVALID_PATH'],
    ['aux.txt', 'INVALID_PATH'],
    ['src/com1.js', 'INVALID_PATH'],
    ['LPT9', 'INVALID_PATH'],
    ['nul.tar.gz', 'INVALID_PATH'],
    ['CONIN$', 'INVALID_PATH'],
    // Windows strips trailing dots/spaces: `.env.` would alias `.env`.
    ['.env.', 'INVALID_PATH'],
    ['notes ', 'INVALID_PATH'],
    // NTFS alternate data streams alias the base file.
    ['.env::$DATA', 'INVALID_PATH'],
    ['a:b', 'PATH_OUTSIDE_WORKSPACE'], // drive-relative on Windows
    ['src/a:b', 'INVALID_PATH'],
    ['a*b', 'INVALID_PATH'],
    ['a?b', 'INVALID_PATH'],
    ['a<b', 'INVALID_PATH'],
    ['a|b', 'INVALID_PATH'],
    ['a"b', 'INVALID_PATH'],
    ['x'.repeat(4097), 'INVALID_PATH'],
  ])('rejects %j with %s', async (input, code) => {
    await expectWorkspaceError(Promise.resolve().then(() => normalizeRelativePath(input)), code);
  });
});

describe('PathGuard', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  describe('resolveExisting', () => {
    it('resolves the workspace root', async () => {
      const resolved = await guard.resolveExisting('.');
      expect(resolved).toEqual({ relativePath: '.', absolutePath: fixture.realRoot });
    });

    it('resolves a nested file to its canonical path', async () => {
      const resolved = await guard.resolveExisting('src/index.ts');
      expect(resolved.relativePath).toBe('src/index.ts');
      expect(resolved.absolutePath).toBe(path.join(fixture.realRoot, 'src/index.ts'));
    });

    it('allows a symlinked file whose target stays inside', async () => {
      const resolved = await guard.resolveExisting('link-inside-file');
      expect(resolved.absolutePath).toBe(path.join(fixture.realRoot, 'src/index.ts'));
    });

    it('allows traversal through a symlinked directory that stays inside', async () => {
      const resolved = await guard.resolveExisting('link-inside-dir/index.ts');
      expect(resolved.absolutePath).toBe(path.join(fixture.realRoot, 'src/index.ts'));
    });

    it.each([
      'link-outside-file',
      'link-outside-dir',
      'link-outside-dir/secret.txt',
      'link-parent',
      'link-parent/outside/secret.txt',
    ])('blocks symlink escape via %j', async (input) => {
      await expectWorkspaceError(guard.resolveExisting(input), 'PATH_OUTSIDE_WORKSPACE');
    });

    it.each(['.env', 'link-to-env', '.git', '.git/config', 'link-parent/workspace/.env'])(
      'blocks denied path %j',
      async (input) => {
        await expectWorkspaceError(guard.resolveExisting(input), 'PATH_BLOCKED');
      },
    );

    it('allows a symlink that leaves and re-enters the workspace', async () => {
      const resolved = await guard.resolveExisting('link-parent/workspace/README.md');
      expect(resolved.absolutePath).toBe(path.join(fixture.realRoot, 'README.md'));
    });

    it('reports a missing path as FILE_NOT_FOUND', async () => {
      await expectWorkspaceError(guard.resolveExisting('missing.txt'), 'FILE_NOT_FOUND');
    });

    it('reports a dangling symlink as FILE_NOT_FOUND', async () => {
      await expectWorkspaceError(guard.resolveExisting('link-dangling'), 'FILE_NOT_FOUND');
    });

    it('reports a file used as a directory as NOT_A_DIRECTORY', async () => {
      await expectWorkspaceError(guard.resolveExisting('README.md/x'), 'NOT_A_DIRECTORY');
    });

    it('never puts host paths in error messages', async () => {
      for (const input of ['link-outside-dir/secret.txt', 'missing.txt', '/etc/passwd', 'README.md/x', '.env']) {
        const error = await guard.resolveExisting(input).catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expectNoHostPath((error as Error).message, fixture);
      }
    });
  });

  describe('resolveForWrite', () => {
    it('resolves an existing regular file', async () => {
      const target = await guard.resolveForWrite('README.md');
      expect(target).toMatchObject({
        relativePath: 'README.md',
        absolutePath: path.join(fixture.realRoot, 'README.md'),
        existingAncestor: fixture.realRoot,
        missingDirectories: [],
        exists: true,
      });
    });

    it('resolves a new file whose parent directories are missing', async () => {
      const target = await guard.resolveForWrite('docs/adr/new.md');
      expect(target).toMatchObject({
        relativePath: 'docs/adr/new.md',
        absolutePath: path.join(fixture.realRoot, 'docs/adr/new.md'),
        existingAncestor: fixture.realRoot,
        missingDirectories: ['docs', 'adr'],
        exists: false,
      });
    });

    it('resolves a new file below a symlinked directory that stays inside', async () => {
      const target = await guard.resolveForWrite('link-inside-dir/new.ts');
      expect(target.absolutePath).toBe(path.join(fixture.realRoot, 'src/new.ts'));
      expect(target.exists).toBe(false);
    });

    it.each(['link-outside-dir/new.txt', 'link-outside-dir/deeper/new.txt', 'link-parent/new.txt'])(
      'blocks a new file whose nearest existing parent escapes: %j',
      async (input) => {
        await expectWorkspaceError(guard.resolveForWrite(input), 'PATH_OUTSIDE_WORKSPACE');
      },
    );

    it('refuses to create below a dangling symlink', async () => {
      await expectWorkspaceError(guard.resolveForWrite('link-dangling/new.txt'), 'INVALID_PATH');
    });

    it.each(['link-inside-file', 'link-outside-file', 'link-dangling'])(
      'refuses to write through a symlink target: %j',
      async (input) => {
        await expectWorkspaceError(guard.resolveForWrite(input), 'INVALID_PATH');
      },
    );

    it.each(['.', 'src'])('refuses to write to a directory: %j', async (input) => {
      await expectWorkspaceError(guard.resolveForWrite(input), 'NOT_A_FILE');
    });

    it('refuses a file used as a parent directory', async () => {
      await expectWorkspaceError(guard.resolveForWrite('README.md/x.txt'), 'NOT_A_DIRECTORY');
    });

    it.each(['.env', '.env.production', 'nested/.ssh/config', 'link-inside-dir/.env', '.git/hooks/pre-commit'])(
      'blocks denied write target %j',
      async (input) => {
        await expectWorkspaceError(guard.resolveForWrite(input), 'PATH_BLOCKED');
      },
    );
  });
});

describe('PathGuard with extra deny patterns', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot, createDenyMatcher([...DEFAULT_DENY_PATTERNS, '*.ts']));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('blocks paths matching an extra pattern, including through symlinks', async () => {
    await expectWorkspaceError(guard.resolveExisting('src/index.ts'), 'PATH_BLOCKED');
    await expectWorkspaceError(guard.resolveExisting('link-inside-file'), 'PATH_BLOCKED');
    await expectWorkspaceError(guard.resolveForWrite('src/new.ts'), 'PATH_BLOCKED');
  });

  it('keeps default patterns in force', async () => {
    await expectWorkspaceError(guard.resolveExisting('.env'), 'PATH_BLOCKED');
  });
});
