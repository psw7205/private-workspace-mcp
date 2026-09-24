import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editTextFile, editTextFileMulti, MAX_EDITS } from '../src/filesystem/file-editor.js';
import type { WriteFileOptions } from '../src/filesystem/file-writer.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { computeRevision } from '../src/filesystem/revision.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, type Fixture } from './helpers.js';

const readWrite = { mode: 'read-write', maxReadBytes: 64, maxWriteBytes: 32 } as const;

describe('editTextFile', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeEach(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const inRoot = (relative: string) => path.join(fixture.root, relative);
  const revisionOf = async (relative: string) => computeRevision(await readFile(inRoot(relative)));
  const edit = async (relative: string, oldString: string, newString: string, replaceAll = false) =>
    editTextFile(guard, readWrite, {
      path: relative,
      oldString,
      newString,
      expectedRevision: await revisionOf(relative),
      replaceAll,
    });

  it('replaces a unique match and returns the new revision', async () => {
    const result = await edit('README.md', 'readme', 'guide');
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# guide\n');
    expect(result).toEqual({
      path: 'README.md',
      replacements: 1,
      bytes_written: 8,
      revision: computeRevision(Buffer.from('# guide\n')),
    });
  });

  it('chains edits with the returned revision', async () => {
    const first = await edit('README.md', 'readme', 'a');
    const second = await editTextFile(guard, readWrite, {
      path: 'README.md',
      oldString: '# a',
      newString: '# b',
      expectedRevision: first.revision,
      replaceAll: false,
    });
    expect(second.replacements).toBe(1);
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# b\n');
  });

  it('reports EDIT_NO_MATCH without touching the file', async () => {
    const error = await expectWorkspaceError(edit('README.md', 'missing', 'x'), 'EDIT_NO_MATCH');
    expect(error.message).toContain('README.md');
    expectNoHostPath(error.message, fixture);
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('reports EDIT_AMBIGUOUS for several matches unless replace_all is set', async () => {
    await writeFile(inRoot('dup.txt'), 'a-a-a\n');
    const error = await expectWorkspaceError(edit('dup.txt', 'a', 'b'), 'EDIT_AMBIGUOUS');
    expectNoHostPath(error.message, fixture);
    expect(await readFile(inRoot('dup.txt'), 'utf8')).toBe('a-a-a\n');

    const result = await edit('dup.txt', 'a', 'b', true);
    expect(result.replacements).toBe(3);
    expect(await readFile(inRoot('dup.txt'), 'utf8')).toBe('b-b-b\n');
  });

  it('inserts new_string literally, including replacement patterns', async () => {
    await edit('README.md', 'readme', "$& $1 $$ $'");
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe("# $& $1 $$ $'\n");
  });

  it('preserves a BOM and CRLF line endings around the edit', async () => {
    await writeFile(inRoot('crlf.txt'), '﻿one\r\ntwo\r\n');
    await edit('crlf.txt', 'two', 'TWO');
    expect(await readFile(inRoot('crlf.txt'), 'utf8')).toBe('﻿one\r\nTWO\r\n');
  });

  it('refuses an edit that would split a surrogate pair', async () => {
    await writeFile(inRoot('emoji.txt'), 'a\u{1F600}b\n');
    await expectWorkspaceError(edit('emoji.txt', '\ud83d', 'X'), 'BINARY_FILE');
    expect(await readFile(inRoot('emoji.txt'), 'utf8')).toBe('a\u{1F600}b\n');
  });

  it('rejects a stale revision', async () => {
    await expectWorkspaceError(
      editTextFile(guard, readWrite, {
        path: 'README.md',
        oldString: 'readme',
        newString: 'x',
        expectedRevision: computeRevision(Buffer.from('stale')),
        replaceAll: false,
      }),
      'REVISION_CONFLICT',
    );
  });

  it('rejects an empty old_string', async () => {
    await expectWorkspaceError(edit('README.md', '', 'x'), 'EDIT_NO_MATCH');
  });

  it('refuses edits in read-only mode', async () => {
    await expectWorkspaceError(
      editTextFile(guard, { ...readWrite, mode: 'read-only' }, {
        path: 'README.md',
        oldString: 'readme',
        newString: 'x',
        expectedRevision: await revisionOf('README.md'),
        replaceAll: false,
      }),
      'READ_ONLY',
    );
  });

  it('reports a missing file', async () => {
    await expectWorkspaceError(
      editTextFile(guard, readWrite, {
        path: 'missing.txt',
        oldString: 'a',
        newString: 'b',
        expectedRevision: computeRevision(Buffer.from('')),
        replaceAll: false,
      }),
      'FILE_NOT_FOUND',
    );
  });

  it('rejects non-UTF-8 content', async () => {
    await writeFile(inRoot('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expectWorkspaceError(edit('latin1.txt', 'caf', 'x'), 'BINARY_FILE');
  });

  it('rejects a result over the write limit', async () => {
    await expectWorkspaceError(edit('README.md', 'readme', 'x'.repeat(40)), 'FILE_TOO_LARGE');
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it.each([
    ['.env', 'PATH_BLOCKED'],
    ['.git/config', 'PATH_BLOCKED'],
    // Symlinked targets are refused before they are followed (M7).
    ['link-to-env', 'INVALID_PATH'],
    ['link-inside-file', 'INVALID_PATH'],
    ['link-outside-file', 'INVALID_PATH'],
    ['link-outside-dir/private.txt', 'PATH_OUTSIDE_WORKSPACE'],
  ] as const)('refuses to edit %j', async (input, code) => {
    const error = await expectWorkspaceError(
      editTextFile(guard, readWrite, {
        path: input,
        oldString: 'x',
        newString: 'y',
        expectedRevision: computeRevision(Buffer.from('')),
        replaceAll: false,
      }),
      code,
    );
    expectNoHostPath(error.message, fixture);
  });
});

describe('editTextFileMulti', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeEach(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const inRoot = (relative: string) => path.join(fixture.root, relative);
  const revisionOf = async (relative: string) => computeRevision(await readFile(inRoot(relative)));
  type Edit = { oldString: string; newString: string; replaceAll?: boolean };
  const multi = async (relative: string, edits: Edit[], options: WriteFileOptions = readWrite) =>
    editTextFileMulti(guard, options, {
      path: relative,
      edits: edits.map((edit) => ({ replaceAll: false, ...edit })),
      expectedRevision: await revisionOf(relative),
    });

  it('applies edits in order and returns per-edit counts', async () => {
    await writeFile(inRoot('multi.txt'), 'a-b-a\n');
    const result = await multi('multi.txt', [
      { oldString: 'b', newString: 'c' },
      { oldString: 'a', newString: 'x', replaceAll: true },
    ]);
    expect(await readFile(inRoot('multi.txt'), 'utf8')).toBe('x-c-x\n');
    expect(result).toEqual({
      path: 'multi.txt',
      replacements: 3,
      edit_replacements: [1, 2],
      bytes_written: 6,
      revision: computeRevision(Buffer.from('x-c-x\n')),
    });
  });

  it('matches each old_string against the result of the earlier edits', async () => {
    await multi('README.md', [
      { oldString: 'readme', newString: 'guide' },
      { oldString: '# guide', newString: '## guide' },
    ]);
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('## guide\n');
  });

  it('changes nothing when a later edit finds no match, and names the edit', async () => {
    const error = await expectWorkspaceError(
      multi('README.md', [
        { oldString: 'readme', newString: 'guide' },
        { oldString: '#', newString: '##' },
        { oldString: 'readme', newString: 'x' },
      ]),
      'EDIT_NO_MATCH',
    );
    expect(error.message).toContain('edits[2]');
    expect(error.message).toContain('README.md');
    expect(error.message).not.toContain('guide');
    expectNoHostPath(error.message, fixture);
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('reports EDIT_AMBIGUOUS for the edit that matches several times', async () => {
    await writeFile(inRoot('dup.txt'), 'a-a-b\n');
    const error = await expectWorkspaceError(
      multi('dup.txt', [
        { oldString: 'b', newString: 'c' },
        { oldString: 'a', newString: 'x' },
      ]),
      'EDIT_AMBIGUOUS',
    );
    expect(error.message).toContain('edits[1]');
    expectNoHostPath(error.message, fixture);
    expect(await readFile(inRoot('dup.txt'), 'utf8')).toBe('a-a-b\n');
  });

  it('rejects an empty old_string with its index', async () => {
    const error = await expectWorkspaceError(
      multi('README.md', [
        { oldString: 'readme', newString: 'x' },
        { oldString: '', newString: 'y' },
      ]),
      'EDIT_NO_MATCH',
    );
    expect(error.message).toContain('edits[1]');
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('refuses an edit that splits a surrogate pair even if a later edit rejoins it', async () => {
    await writeFile(inRoot('emoji.txt'), 'a\u{1F600}b\n');
    const error = await expectWorkspaceError(
      multi('emoji.txt', [
        { oldString: '\ud83d', newString: 'X' },
        { oldString: 'X\ude00', newString: 'Y' },
      ]),
      'BINARY_FILE',
    );
    expect(error.message).toContain('edits[0]');
    expect(await readFile(inRoot('emoji.txt'), 'utf8')).toBe('a\u{1F600}b\n');
  });

  it('refuses an old_string that matches across two surrogate pairs', async () => {
    await writeFile(inRoot('emoji.txt'), '\u{1F600}\u{1F600}\n');
    await expectWorkspaceError(multi('emoji.txt', [{ oldString: '\ude00\ud83d', newString: '' }]), 'BINARY_FILE');
    expect(await readFile(inRoot('emoji.txt'), 'utf8')).toBe('\u{1F600}\u{1F600}\n');
  });

  it('refuses a lone surrogate in new_string', async () => {
    const error = await expectWorkspaceError(
      multi('README.md', [
        { oldString: 'readme', newString: 'x' },
        { oldString: 'x', newString: '\ud83d' },
      ]),
      'BINARY_FILE',
    );
    expect(error.message).toContain('edits[1]');
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('checks the write limit on the final content', async () => {
    await expectWorkspaceError(multi('README.md', [{ oldString: 'readme', newString: 'x'.repeat(40) }]), 'FILE_TOO_LARGE');
    const result = await multi('README.md', [
      { oldString: 'readme', newString: 'x'.repeat(40) },
      { oldString: 'x'.repeat(40), newString: 'ok' },
    ]).catch((error: unknown) => error);
    // An intermediate result over the write limit is refused too, so edits cannot grow memory without bound.
    expect(result).toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect((result as Error).message).toContain('edits[0]');
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('refuses a replace_all that would build a string far over the write limit, before building it', async () => {
    const limits = { mode: 'read-write', maxReadBytes: 1 << 20, maxWriteBytes: 1 << 20 } as const;
    await writeFile(inRoot('big.txt'), 'a'.repeat(1 << 20));
    // 1 MiB x 600 code units exceeds V8's maximum string length, so building it throws RangeError.
    for (const call of [
      () => multi('big.txt', [{ oldString: 'a', newString: 'b'.repeat(600), replaceAll: true }], limits),
      async () =>
        editTextFile(guard, limits, {
          path: 'big.txt',
          oldString: 'a',
          newString: 'b'.repeat(600),
          expectedRevision: await revisionOf('big.txt'),
          replaceAll: true,
        }),
    ]) {
      await expectWorkspaceError(call(), 'FILE_TOO_LARGE');
    }
  });

  it('checks the path before the edit text', async () => {
    await expectWorkspaceError(multi('.env', [{ oldString: '\ud83d', newString: 'x' }]), 'PATH_BLOCKED');
  });

  it('bounds the number of edits', async () => {
    expect(MAX_EDITS).toBe(100);
    const edits = Array.from({ length: MAX_EDITS + 1 }, () => ({ oldString: '#', newString: '#' }));
    await expectWorkspaceError(multi('README.md', edits), 'EDIT_NO_MATCH');
    await expectWorkspaceError(multi('README.md', []), 'EDIT_NO_MATCH');
  });

  it('rejects a stale revision and read-only mode', async () => {
    await expectWorkspaceError(
      editTextFileMulti(guard, readWrite, {
        path: 'README.md',
        edits: [{ oldString: 'readme', newString: 'x', replaceAll: false }],
        expectedRevision: computeRevision(Buffer.from('stale')),
      }),
      'REVISION_CONFLICT',
    );
    await expectWorkspaceError(
      multi('README.md', [{ oldString: 'readme', newString: 'x' }], { ...readWrite, mode: 'read-only' }),
      'READ_ONLY',
    );
  });

  it.each([
    ['.env', 'PATH_BLOCKED'],
    ['link-to-env', 'INVALID_PATH'],
    ['link-outside-dir/private.txt', 'PATH_OUTSIDE_WORKSPACE'],
  ] as const)('refuses to edit %j', async (input, code) => {
    const error = await expectWorkspaceError(
      editTextFileMulti(guard, readWrite, {
        path: input,
        edits: [{ oldString: 'x', newString: 'y', replaceAll: false }],
        expectedRevision: computeRevision(Buffer.from('')),
      }),
      code,
    );
    expectNoHostPath(error.message, fixture);
  });
});

describe('editTextFile surrogate boundaries', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeEach(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('refuses an old_string that matches across two surrogate pairs', async () => {
    const target = path.join(fixture.root, 'emoji.txt');
    await writeFile(target, '\u{1F600}\u{1F600}\n');
    await expectWorkspaceError(
      editTextFile(guard, readWrite, {
        path: 'emoji.txt',
        oldString: '\ude00\ud83d',
        newString: '',
        expectedRevision: computeRevision(await readFile(target)),
        replaceAll: false,
      }),
      'BINARY_FILE',
    );
    expect(await readFile(target, 'utf8')).toBe('\u{1F600}\u{1F600}\n');
  });
});
