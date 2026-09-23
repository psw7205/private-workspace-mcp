import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findFiles } from '../src/filesystem/file-search.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { createDenyMatcher, DEFAULT_DENY_PATTERNS } from '../src/policy/deny-list.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, type Fixture } from './helpers.js';

const options = { maxSearchFiles: 100, maxReadBytes: 1024 };

describe('findFiles', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    await mkdir(path.join(fixture.root, 'src/lib'), { recursive: true });
    await mkdir(path.join(fixture.root, 'docs'));
    await mkdir(path.join(fixture.root, '.github'));
    await writeFile(path.join(fixture.root, 'src/lib/util.ts'), 'export const a = 1;\n');
    await writeFile(path.join(fixture.root, 'src/lib/util.test.ts'), 'test\n');
    await writeFile(path.join(fixture.root, 'src/server.pem'), 'cert');
    await writeFile(path.join(fixture.root, 'docs/guide.md'), '# guide\n');
    await writeFile(path.join(fixture.root, '.github/ci.yml'), 'on: push\n');
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(fixture.root, 'src/pipe.ts')]);
    }
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  const find = (pattern: string, extra: { path?: string; limit?: number } = {}) =>
    findFiles(guard, options, { path: extra.path ?? '.', pattern, limit: extra.limit ?? 100, includeIgnored: false });

  it('matches a glob recursively, name-sorted depth-first, with sizes', async () => {
    const result = await find('**/*.ts');
    expect(result).toEqual({
      path: '.',
      pattern: '**/*.ts',
      files: [
        { path: 'src/index.ts', size: 11 },
        { path: 'src/lib/util.test.ts', size: 5 },
        { path: 'src/lib/util.ts', size: 20 },
      ],
      truncated: false,
      scan_limit_reached: false,
    });
  });

  it('never follows symlinks or returns special files', async () => {
    const paths = (await find('**')).files.map((file) => file.path);
    expect(paths).not.toContain('link-inside-dir/index.ts');
    expect(paths).not.toContain('link-outside-dir/secret.txt');
    expect(paths).not.toContain('link-inside-file');
    expect(paths).not.toContain('src/pipe.ts');
    expect(paths).toContain('README.md');
  });

  it('omits denied files, including under explicitly named dot paths', async () => {
    const all = (await find('**/*')).files.map((file) => file.path);
    expect(all).not.toContain('src/server.pem');
    const dotted = (await find('.*')).files.map((file) => file.path);
    expect(dotted).toEqual([]);
    expect((await find('.git/**')).files).toEqual([]);
  });

  it('matches dot paths only when the pattern names them', async () => {
    expect((await find('**/*.yml')).files).toEqual([]);
    expect((await find('.github/*.yml')).files).toEqual([{ path: '.github/ci.yml', size: 9 }]);
  });

  it('matches the pattern relative to the search path and returns workspace paths', async () => {
    const result = await find('*.ts', { path: 'src/lib' });
    expect(result.files.map((file) => file.path)).toEqual(['src/lib/util.test.ts', 'src/lib/util.ts']);
    expect((await find('./src/index.ts')).files).toEqual([{ path: 'src/index.ts', size: 11 }]);
  });

  it('applies the guard\'s extra deny patterns', async () => {
    const strict = new PathGuard(fixture.realRoot, createDenyMatcher([...DEFAULT_DENY_PATTERNS, 'docs']));
    const result = await findFiles(strict, options, { path: '.', pattern: '**/*.md', limit: 100, includeIgnored: false });
    expect(result.files.map((file) => file.path)).toEqual(['README.md']);
  });

  it('truncates at the result limit', async () => {
    const result = await find('**', { limit: 2 });
    expect(result.files).toHaveLength(2);
    expect(result).toMatchObject({ truncated: true, scan_limit_reached: false });
  });

  it('stops at the scanned-file limit', async () => {
    const result = await findFiles(guard, { ...options, maxSearchFiles: 2 }, { path: '.', pattern: '**/*.md', limit: 100, includeIgnored: false });
    expect(result).toMatchObject({ truncated: true, scan_limit_reached: true });
  });

  it('stops walking once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      findFiles(guard, { ...options, signal: controller.signal }, { path: '.', pattern: '**', limit: 100, includeIgnored: false }),
    ).rejects.toThrow();
  });

  it.each([
    ['README.md', 'NOT_A_DIRECTORY'],
    ['link-outside-dir', 'PATH_OUTSIDE_WORKSPACE'],
    ['.git', 'PATH_BLOCKED'],
    ['missing', 'FILE_NOT_FOUND'],
  ] as const)('rejects search path %j', async (input, code) => {
    const error = await expectWorkspaceError(find('**', { path: input }), code);
    expectNoHostPath(error.message, fixture);
  });

  it('never returns host paths', async () => {
    expectNoHostPath(JSON.stringify(await find('**')), fixture);
  });
});

describe('findFiles with ignore files', () => {
  let base: string;
  let guard: PathGuard;

  const files: Record<string, string> = {
    '.gitignore': 'dist/\n*.log\n!keep.log\nlogs/\n',
    'a.log': 'x',
    'keep.log': 'x',
    'dist/out.js': 'x',
    'logs': 'a file named like an ignored directory',
    'src/.gitignore': 'generated.ts\n',
    'src/generated.ts': 'x',
    'src/main.ts': 'x',
    'generated.ts': 'x',
    'pkg/.ignore': 'tmp\n',
    'pkg/tmp/a.txt': 'x',
    'pkg/build.txt': 'x',
    'pkg/sub/.gitignore': '!a.log\n',
    'pkg/sub/a.log': 'x',
    'secrets/.gitignore': '!*\n',
    'linked/data.txt': 'x',
    'star.txt': '*\n',
  };

  beforeAll(async () => {
    base = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'pwmcp-ignore-'))), 'workspace');
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
      await writeFile(path.join(base, relative), content);
    }
    // A symlinked ignore file is not followed, so "*" here must not hide linked/data.txt.
    await symlink(path.join(base, 'star.txt'), path.join(base, 'linked/.ignore'));
    guard = new PathGuard(base);
  });

  afterAll(async () => {
    await rm(path.dirname(base), { recursive: true, force: true });
  });

  const find = async (searchPath = '.', includeIgnored = false) =>
    (await findFiles(guard, options, { path: searchPath, pattern: '**', limit: 100, includeIgnored })).files.map(
      (file) => file.path,
    );

  it('applies .gitignore and .ignore rules from every traversed directory', async () => {
    expect(await find()).toEqual([
      'generated.ts',
      'keep.log',
      'linked/data.txt',
      'logs',
      'pkg/build.txt',
      'pkg/sub/a.log',
      'src/main.ts',
      'star.txt',
    ]);
  });

  it('applies ignore files above the search path', async () => {
    expect(await find('pkg')).toEqual(['pkg/build.txt', 'pkg/sub/a.log']);
    expect(await find('src')).toEqual(['src/main.ts']);
  });

  it('includes ignored files on request', async () => {
    const all = await find('.', true);
    expect(all).toContain('dist/out.js');
    expect(all).toContain('src/generated.ts');
    expect(all).toContain('pkg/tmp/a.txt');
  });

  it('keeps the deny list in force when ignore files are skipped or negate it', async () => {
    await writeFile(path.join(base, 'secrets/.env'), 'SECRET=1\n');
    expect(await find('.', true)).not.toContain('secrets/.env');
    expect(await find()).not.toContain('secrets/.env');
  });
});
