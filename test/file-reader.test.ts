import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readTextFile } from '../src/filesystem/file-reader.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, type Fixture } from './helpers.js';

const limits = { maxReadBytes: 64 };

describe('readTextFile', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    await mkdir(path.join(fixture.root, 'data'));
    await writeFile(path.join(fixture.root, 'data/lines.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    await writeFile(path.join(fixture.root, 'data/no-newline.txt'), 'a\r\nb');
    await writeFile(path.join(fixture.root, 'data/empty.txt'), '');
    await writeFile(path.join(fixture.root, 'data/binary.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x03]));
    await writeFile(path.join(fixture.root, 'data/large.txt'), 'x'.repeat(65));
    await writeFile(path.join(fixture.root, 'data/exact.txt'), 'y'.repeat(64));
    await writeFile(path.join(fixture.root, 'data/utf8.txt'), '한글\n');
    await writeFile(path.join(fixture.root, 'data/bom.txt'), '\uFEFFbom\n');
    await writeFile(path.join(fixture.root, 'data/latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    // "한글" in EUC-KR.
    await writeFile(path.join(fixture.root, 'data/euc-kr.txt'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('returns content, size, and a whole-file sha256 revision', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/lines.txt' });
    const bytes = Buffer.from('one\ntwo\nthree\nfour\nfive\n');
    expect(result).toEqual({
      path: 'data/lines.txt',
      content: 'one\ntwo\nthree\nfour\nfive\n',
      size: bytes.length,
      total_lines: 5,
      start_line: 1,
      end_line: 5,
      truncated: false,
      revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  });

  it('paginates by line while keeping the whole-file revision', async () => {
    const full = await readTextFile(guard, limits, { path: 'data/lines.txt' });
    const page = await readTextFile(guard, limits, { path: 'data/lines.txt', startLine: 2, maxLines: 2 });
    expect(page).toMatchObject({
      content: 'two\nthree\n',
      start_line: 2,
      end_line: 3,
      truncated: true,
      next_start_line: 4,
      revision: full.revision,
    });
  });

  it('returns an empty window past the end of the file', async () => {
    const page = await readTextFile(guard, limits, { path: 'data/lines.txt', startLine: 10 });
    expect(page).toMatchObject({ content: '', start_line: 10, end_line: 9, truncated: false, total_lines: 5 });
  });

  it('preserves CRLF and a missing trailing newline', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/no-newline.txt' });
    expect(result).toMatchObject({ content: 'a\r\nb', total_lines: 2 });
  });

  it('reads an empty file', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/empty.txt' });
    expect(result).toMatchObject({ content: '', size: 0, total_lines: 0, truncated: false });
  });

  it('decodes UTF-8', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/utf8.txt' });
    expect(result.content).toBe('한글\n');
  });

  it('keeps a leading BOM so a round trip preserves it', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/bom.txt' });
    expect(result.content).toBe('\uFEFFbom\n');
  });

  // Lossy decoding would turn these bytes into U+FFFD, and writing the content back
  // with the matching revision would silently corrupt the file.
  it.each(['data/latin1.txt', 'data/euc-kr.txt'])('rejects non-UTF-8 content in %j', async (input) => {
    const error = await expectWorkspaceError(readTextFile(guard, limits, { path: input }), 'BINARY_FILE');
    expect(error.message).toContain(input);
    expectNoHostPath(error.message, fixture);
  });

  it('allows a file exactly at the read limit', async () => {
    const result = await readTextFile(guard, limits, { path: 'data/exact.txt' });
    expect(result.size).toBe(64);
  });

  it('rejects a file over the read limit', async () => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/large.txt' }), 'FILE_TOO_LARGE');
  });

  it('rejects binary content', async () => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/binary.bin' }), 'BINARY_FILE');
  });

  it('rejects a directory', async () => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'data' }), 'NOT_A_FILE');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', async () => {
    execFileSync('mkfifo', [path.join(fixture.root, 'data/pipe')]);
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/pipe' }), 'NOT_A_FILE');
  });

  it('reads through a symlink that stays inside', async () => {
    const result = await readTextFile(guard, limits, { path: 'link-inside-file' });
    expect(result.content).toBe('export {};\n');
  });

  it('blocks symlink escape', async () => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'link-outside-file' }), 'PATH_OUTSIDE_WORKSPACE');
  });

  it.each(['.env', 'link-to-env', '.git/config'])('blocks denied file %j', async (input) => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: input }), 'PATH_BLOCKED');
  });

  it('reports a missing file', async () => {
    await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/missing.txt' }), 'FILE_NOT_FOUND');
  });
});
