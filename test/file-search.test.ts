import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findFiles, searchText } from '../src/filesystem/file-search.js';
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

  it('rejects a glob that expands too far before walking', async () => {
    const error = await expectWorkspaceError(find('{a,b}'.repeat(7)), 'INVALID_PATH');
    expectNoHostPath(error.message, fixture);
  });
});

describe('findFiles with ignore files', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  // Rooted at proj/ inside the standard fixture so the fixture's own files stay out of the way.
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
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    const inProject = (relative: string) => path.join(fixture.root, 'proj', relative);
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(inProject(relative)), { recursive: true });
      await writeFile(inProject(relative), content);
    }
    // A symlinked ignore file is not followed, so "*" here must not hide linked/data.txt.
    await symlink(inProject('star.txt'), inProject('linked/.ignore'));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  const find = async (searchPath = 'proj', includeIgnored = false) =>
    (await findFiles(guard, options, { path: searchPath, pattern: '**', limit: 100, includeIgnored })).files.map(
      (file) => file.path,
    );

  it('applies .gitignore and .ignore rules from every traversed directory', async () => {
    expect(await find()).toEqual(
      [
        'generated.ts',
        'keep.log',
        'linked/data.txt',
        'logs',
        'pkg/build.txt',
        'pkg/sub/a.log',
        'src/main.ts',
        'star.txt',
      ].map((relative) => `proj/${relative}`),
    );
  });

  it('applies ignore files above the search path', async () => {
    expect(await find('proj/pkg')).toEqual(['proj/pkg/build.txt', 'proj/pkg/sub/a.log']);
    expect(await find('proj/src')).toEqual(['proj/src/main.ts']);
  });

  it('searches a directory the caller names even when ignore rules above it exclude it', async () => {
    expect(await find('proj/dist')).toEqual(['proj/dist/out.js']);
  });

  it('includes ignored files on request', async () => {
    const all = await find('proj', true);
    expect(all).toContain('proj/dist/out.js');
    expect(all).toContain('proj/src/generated.ts');
    expect(all).toContain('proj/pkg/tmp/a.txt');
  });

  it('keeps the deny list in force when ignore files are skipped or negate it', async () => {
    await writeFile(path.join(fixture.root, 'proj/secrets/.env'), 'SECRET=1\n');
    expect(await find('proj', true)).not.toContain('proj/secrets/.env');
    expect(await find()).not.toContain('proj/secrets/.env');
  });
});

describe('searchText', () => {
  let fixture: Fixture;
  let guard: PathGuard;
  const long = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    const write = async (relative: string, content: string | Buffer) => {
      await mkdir(path.dirname(path.join(fixture.root, relative)), { recursive: true });
      await writeFile(path.join(fixture.root, relative), content);
    };
    await write('src/a.ts', 'const needle = 1;\nconst other = 2;\n// Needle needle again\n');
    await write('src/b.md', 'first line\r\nhas NEEDLE here\r\n');
    await write('src/long.txt', `${long}\n`);
    await write('src/bin.dat', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    await write('src/latin1.txt', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xe9, 0x0a]));
    await write('src/big.txt', `needle${'x'.repeat(2000)}`);
    await write('.env', 'NEEDLE=secret\n');
    await write('.gitignore', 'ignored/\n');
    await write('ignored/c.ts', 'needle\n');
    await write('uni/emoji.txt', '😀 Café Ünïcode\n');
    await write('lines/trailing.txt', 'a\n\n');
    await write('lines/empty.txt', '');
    await write('lines/crlf.txt', 'x\r\n \r\n');
    await write('lines/no-newline.txt', 'x\ny');
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  const search = (
    query: string,
    extra: { path?: string; glob?: string; caseSensitive?: boolean; includeIgnored?: boolean; limit?: number; regex?: boolean } = {},
    searchOptions: { maxSearchFiles?: number; signal?: AbortSignal } = {},
  ) =>
    searchText(
      guard,
      { maxSearchFiles: searchOptions.maxSearchFiles ?? 100, maxReadBytes: 1024, signal: searchOptions.signal },
      {
        path: extra.path ?? '.',
        query,
        glob: extra.glob,
        caseSensitive: extra.caseSensitive ?? false,
        includeIgnored: extra.includeIgnored ?? false,
        limit: extra.limit ?? 100,
        regex: extra.regex ?? false,
      },
    );

  it('finds the first match of each line, ignoring case by default', async () => {
    const result = await search('needle', { path: 'src', glob: '*.{ts,md}' });
    expect(result).toEqual({
      path: 'src',
      query: 'needle',
      matches: [
        { path: 'src/a.ts', line: 1, column: 7, text: 'const needle = 1;' },
        { path: 'src/a.ts', line: 3, column: 4, text: '// Needle needle again' },
        { path: 'src/b.md', line: 2, column: 5, text: 'has NEEDLE here' },
      ],
      files_searched: 3,
      truncated: false,
      scan_limit_reached: false,
      bytesRead: expect.any(Number),
    });
  });

  it('matches case-sensitively on request', async () => {
    const result = await search('Needle', { path: 'src', glob: '*.ts', caseSensitive: true });
    expect(result.matches).toEqual([{ path: 'src/a.ts', line: 3, column: 4, text: '// Needle needle again' }]);
  });

  it('treats the query literally', async () => {
    expect((await search('n.edle', { path: 'src' })).matches).toEqual([]);
    expect((await search('(a+)+$', { path: 'src' })).matches).toEqual([]);
  });

  it('matches a regex per line, ignoring case by default, with the literal result shape', async () => {
    const result = await search('ne+dle\\s', { path: 'src', glob: '*.{ts,md}', regex: true });
    expect(result).toEqual({
      path: 'src',
      query: 'ne+dle\\s',
      matches: [
        { path: 'src/a.ts', line: 1, column: 7, text: 'const needle = 1;' },
        { path: 'src/a.ts', line: 3, column: 4, text: '// Needle needle again' },
        { path: 'src/b.md', line: 2, column: 5, text: 'has NEEDLE here' },
      ],
      files_searched: 3,
      truncated: false,
      scan_limit_reached: false,
      bytesRead: expect.any(Number),
    });
  });

  it('matches a regex case-sensitively on request', async () => {
    const result = await search('N\\w+', { path: 'src', glob: '*.{ts,md}', caseSensitive: true, regex: true });
    expect(result.matches).toEqual([
      { path: 'src/a.ts', line: 3, column: 4, text: '// Needle needle again' },
      { path: 'src/b.md', line: 2, column: 5, text: 'has NEEDLE here' },
    ]);
  });

  it('anchors a regex to each line without its line break', async () => {
    const result = await search('^has.*here$', { path: 'src', regex: true });
    expect(result.matches).toEqual([{ path: 'src/b.md', line: 2, column: 1, text: 'has NEEDLE here' }]);
  });

  it('numbers lines like read_file, without a line after the final line break', async () => {
    const result = await search('^\\s*$', { path: 'lines', regex: true });
    expect(result.matches).toEqual([
      { path: 'lines/crlf.txt', line: 2, column: 1, text: ' ' },
      { path: 'lines/trailing.txt', line: 2, column: 1, text: '' },
    ]);
    expect((await search('^y$', { path: 'lines', regex: true })).matches).toEqual([
      { path: 'lines/no-newline.txt', line: 2, column: 1, text: 'y' },
    ]);
  });

  it('interprets the query as a regex only on request', async () => {
    expect((await search('n.edle', { path: 'src', glob: '*.ts' })).matches).toEqual([]);
    expect((await search('n.edle', { path: 'src', glob: '*.ts', regex: true })).matches).toHaveLength(2);
  });

  it('reports regex columns in UTF-16 code units like literal search', async () => {
    const literal = await search('café ünï', { path: 'uni' });
    const regex = await search('caf. ü\\pL+', { path: 'uni', regex: true });
    expect(literal.matches).toEqual([{ path: 'uni/emoji.txt', line: 1, column: 4, text: '😀 Café Ünïcode' }]);
    expect(regex.matches).toEqual(literal.matches);
  });

  it('keeps ignore and deny rules in regex mode', async () => {
    const paths = (await search('^needle', { regex: true })).matches.map((match) => match.path);
    expect(paths).not.toContain('ignored/c.ts');
    const withIgnored = (await search('^needle', { includeIgnored: true, regex: true })).matches.map((match) => match.path);
    expect(withIgnored).toContain('ignored/c.ts');
    expect(withIgnored).not.toContain('.env');
  });

  it.each([
    ['(', 'missing closing'],
    ['(?=a)', 'unsupported'],
    ['\\1', 'invalid escape'],
    ['a'.repeat(257), 'at most 256 characters'],
    ['\\w{100}!', 'too complex'],
  ])('rejects regex %j before searching', async (query, reason) => {
    const controller = new AbortController();
    controller.abort();
    const error = await expectWorkspaceError(search(query, { regex: true }, { signal: controller.signal }), 'INVALID_PATH');
    expect(error.message).toContain('regex');
    expect(error.message).toContain(reason);
    expectNoHostPath(error.message, fixture);
  });

  it('quotes only the client\'s pattern in a case-insensitive regex error', async () => {
    const error = await expectWorkspaceError(search('(a', { regex: true }), 'INVALID_PATH');
    expect(error.message).toContain('(a');
    expect(error.message).not.toContain('(?i)');
  });

  it('shows a window around a match in a long line', async () => {
    const [match] = (await search('NEEDLE', { path: 'src', glob: 'long.txt' })).matches;
    expect(match?.column).toBe(301);
    expect(match?.text.length).toBeLessThanOrEqual(202);
    expect(match?.text).toContain('NEEDLE');
  });

  it('skips binary, non-UTF-8, oversized, denied, symlinked, and ignored files', async () => {
    const paths = new Set((await search('needle')).matches.map((match) => match.path));
    expect([...paths].sort()).toEqual(['src/a.ts', 'src/b.md', 'src/long.txt']);
  });

  it('searches ignored files on request, but never denied ones', async () => {
    const paths = (await search('needle', { includeIgnored: true })).matches.map((match) => match.path);
    expect(paths).toContain('ignored/c.ts');
    expect(paths).not.toContain('.env');
  });

  it('truncates at the result limit', async () => {
    const result = await search('needle', { limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result).toMatchObject({ truncated: true, scan_limit_reached: false });
  });

  it('stops at the scanned-file limit', async () => {
    const result = await search('needle', {}, { maxSearchFiles: 1 });
    expect(result).toMatchObject({ truncated: true, scan_limit_reached: true });
  });

  it('stops once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(search('needle', {}, { signal: controller.signal })).rejects.toThrow();
  });

  it.each([
    ['src/a.ts', 'NOT_A_DIRECTORY'],
    ['link-outside-dir', 'PATH_OUTSIDE_WORKSPACE'],
    ['.git', 'PATH_BLOCKED'],
  ] as const)('rejects search path %j', async (input, code) => {
    const error = await expectWorkspaceError(search('needle', { path: input }), code);
    expectNoHostPath(error.message, fixture);
  });

  it('never returns host paths', async () => {
    expectNoHostPath(JSON.stringify(await search('e')), fixture);
  });
});

describe('searchText regex cost', () => {
  const size = 1024 * 1024;
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    await mkdir(path.join(fixture.root, 'big'));
    await writeFile(path.join(fixture.root, 'big/one-line.txt'), `${'a'.repeat(size - 2)}!\n`);
    // Alone in its directory, so the walker has no later entry at which to notice an abort.
    await mkdir(path.join(fixture.root, 'abort'));
    await writeFile(path.join(fixture.root, 'abort/lines.txt'), `${'a'.repeat(1023)}!\n`.repeat(size / 1025));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  const search = (query: string, file: string, options: { signal?: AbortSignal; path?: string } = {}) =>
    searchText(
      guard,
      { maxSearchFiles: 10, maxReadBytes: size, signal: options.signal },
      { path: options.path ?? 'big', query, glob: file, caseSensitive: false, includeIgnored: false, limit: 100_000, regex: true },
    );

  // No wall-clock assertion (CI variance); a backtracking engine would not finish within the test timeout.
  it.each(['(a+)+b', '(a|aa)+$', '(a*)*c', '(x+x+)+y'])('matches pathological regex %j over 1 MiB', async (query) => {
    const result = await search(query, 'one-line.txt');
    expect(result.files_searched).toBe(1);
  });

  it('yields within a file so an abort interrupts a long regex scan', async () => {
    // Scanning the file takes about a second; the abort lands mid-file.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(search('\\w{80}!', 'lines.txt', { signal: controller.signal, path: 'abort' })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
