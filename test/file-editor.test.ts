import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceError } from '../src/errors/errors.js';
import {
  editTextFile,
  editTextFileMulti,
  MAX_EDITS,
  previewEditTextFile,
  previewEditTextFileMulti,
  type MultiEditFileParams,
  type TextEdit,
} from '../src/filesystem/file-editor.js';
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

  it('passes the signal to the write, so an aborted edit changes nothing (M43)', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { ...readWrite, signal: controller.signal };
    const revision = await revisionOf('README.md');
    await expect(
      editTextFile(guard, options, {
        path: 'README.md',
        oldString: 'readme',
        newString: 'late',
        expectedRevision: revision,
        replaceAll: false,
      }),
    ).rejects.toThrow();
    await expect(
      editTextFileMulti(guard, options, {
        path: 'README.md',
        edits: [{ oldString: 'readme', newString: 'late', replaceAll: false }],
        expectedRevision: revision,
      }),
    ).rejects.toThrow();
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
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

describe('edit dry run', () => {
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
  const snapshot = async (relative: string) => {
    const target = inRoot(relative);
    return {
      bytes: await readFile(target).catch(() => undefined),
      mtime: (await stat(target).catch(() => undefined))?.mtimeMs,
    };
  };

  it('returns the revision and diff of the edit without writing', async () => {
    await writeFile(inRoot('src/lines.txt'), 'one\ntwo\nthree\n');
    const before = await snapshot('src/lines.txt');
    const params = {
      path: 'src/lines.txt',
      oldString: 'two',
      newString: 'TWO',
      expectedRevision: await revisionOf('src/lines.txt'),
      replaceAll: false,
    };
    const preview = await previewEditTextFile(guard, readWrite, params);
    expect(preview).toEqual({
      path: 'src/lines.txt',
      dry_run: true,
      replacements: 1,
      bytes_written: 0,
      revision: computeRevision(Buffer.from('one\nTWO\nthree\n')),
      diff: '--- a/src/lines.txt\n+++ b/src/lines.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
      diff_truncated: false,
    });
    expect(await snapshot('src/lines.txt')).toEqual(before);

    // The same edit applied for real produces the previewed revision.
    const applied = await editTextFile(guard, readWrite, params);
    expect(applied.revision).toBe(preview.revision);
  });

  it('previews several edits with per-edit counts', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join('');
    await writeFile(inRoot('many.txt'), content);
    const before = await snapshot('many.txt');
    const params = {
      path: 'many.txt',
      edits: [
        { oldString: 'l2\n', newString: 'two\n', replaceAll: false },
        { oldString: 'l19\n', newString: '', replaceAll: false },
        { oldString: 'two', newString: 'TWO', replaceAll: false },
      ],
      expectedRevision: computeRevision(Buffer.from(content)),
    };
    const limits = { mode: 'read-write', maxReadBytes: 1024, maxWriteBytes: 1024 } as const;
    const preview = await previewEditTextFileMulti(guard, limits, params);
    expect(preview).toMatchObject({ path: 'many.txt', dry_run: true, replacements: 3, edit_replacements: [1, 1, 1] });
    expect(preview.diff).toBe(
      '--- a/many.txt\n+++ b/many.txt\n' +
        '@@ -1,5 +1,5 @@\n l1\n-l2\n+TWO\n l3\n l4\n l5\n' +
        '@@ -16,5 +16,4 @@\n l16\n l17\n l18\n-l19\n l20\n',
    );
    expect(await snapshot('many.txt')).toEqual(before);
    const applied = await editTextFileMulti(guard, limits, params);
    expect(applied.revision).toBe(preview.revision);
  });

  it('returns an empty diff and the current revision for an edit that changes nothing', async () => {
    const revision = await revisionOf('README.md');
    const preview = await previewEditTextFile(guard, readWrite, {
      path: 'README.md',
      oldString: 'readme',
      newString: 'readme',
      expectedRevision: revision,
      replaceAll: false,
    });
    expect(preview).toMatchObject({ diff: '', diff_truncated: false, revision, replacements: 1 });
  });

  it('truncates a large diff and flags it', async () => {
    const limits = { mode: 'read-write', maxReadBytes: 1 << 20, maxWriteBytes: 1 << 20 } as const;
    const content = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join('');
    await writeFile(inRoot('big.txt'), content);
    const preview = await previewEditTextFile(guard, limits, {
      path: 'big.txt',
      oldString: 'line',
      newString: 'LINE',
      expectedRevision: computeRevision(Buffer.from(content)),
      replaceAll: true,
    });
    expect(preview).toMatchObject({ replacements: 20_000, diff_truncated: true });
    expect(Buffer.byteLength(preview.diff)).toBeLessThanOrEqual(64 * 1024);
    expect(await readFile(inRoot('big.txt'), 'utf8')).toBe(content);
  });

  type Case = [name: string, setup: () => Promise<void>, options: WriteFileOptions, params: () => Promise<MultiEditFileParams>];
  const one =
    (relative: string, oldString: string, newString: string) => async (): Promise<MultiEditFileParams> => ({
      path: relative,
      edits: [{ oldString, newString, replaceAll: false }],
      expectedRevision: await revisionOf(relative).catch(() => computeRevision(Buffer.from(''))),
    });
  const none = async () => undefined;
  const cases: Case[] = [
    ['no match', none, readWrite, one('README.md', 'missing', 'x')],
    ['ambiguous', () => writeFile(inRoot('dup.txt'), 'a-a\n'), readWrite, one('dup.txt', 'a', 'b')],
    ['empty old_string', none, readWrite, one('README.md', '', 'x')],
    ['read-only', none, { ...readWrite, mode: 'read-only' }, one('README.md', 'readme', 'x')],
    ['missing file', none, readWrite, one('missing.txt', 'a', 'b')],
    ['non-UTF-8', () => writeFile(inRoot('latin1.txt'), Buffer.from([0x63, 0xe9, 0x0a])), readWrite, one('latin1.txt', 'c', 'x')],
    ['over the write limit', none, readWrite, one('README.md', 'readme', 'x'.repeat(40))],
    // 23 UTF-16 code units pass the pre-check; the 43 UTF-8 bytes fail the final check.
    ['over the write limit in UTF-8 bytes', none, readWrite, one('README.md', 'readme', 'é'.repeat(20))],
    ['split surrogate pair', () => writeFile(inRoot('emoji.txt'), 'a\u{1F600}\n'), readWrite, one('emoji.txt', '\ud83d', 'X')],
    ['denied path', none, readWrite, one('.env', 'SECRET', 'x')],
    ['symlink target', none, readWrite, one('link-inside-file', 'export', 'x')],
    ['outside the workspace', none, readWrite, one('link-outside-dir/private.txt', 'outside', 'x')],
    [
      'stale revision',
      none,
      readWrite,
      async () => ({
        path: 'README.md',
        edits: [{ oldString: 'readme', newString: 'x', replaceAll: false }],
        expectedRevision: computeRevision(Buffer.from('stale')),
      }),
    ],
    [
      'later edit without a match',
      none,
      readWrite,
      async () => ({
        path: 'README.md',
        edits: [
          { oldString: 'readme', newString: 'guide', replaceAll: false },
          { oldString: 'readme', newString: 'x', replaceAll: false },
        ],
        expectedRevision: await revisionOf('README.md'),
      }),
    ],
    [
      'too many edits',
      none,
      readWrite,
      async () => ({
        path: 'README.md',
        edits: Array.from({ length: MAX_EDITS + 1 }, () => ({ oldString: '#', newString: '#', replaceAll: false })),
        expectedRevision: await revisionOf('README.md'),
      }),
    ],
  ];

  it.each(cases)('fails like the real edit: %s', async (_name, setup, options, params) => {
    await setup();
    const input = await params();
    const before = await snapshot(input.path);
    const real = await editTextFileMulti(guard, options, input).then(
      () => {
        throw new Error('the real edit succeeded');
      },
      (error: unknown) => error,
    );
    if (!(real instanceof WorkspaceError)) throw real;
    const dry = await expectWorkspaceError(previewEditTextFileMulti(guard, options, input), real.code);
    expect(dry.message).toBe(real.message);
    expectNoHostPath(dry.message, fixture);
    expect(await snapshot(input.path)).toEqual(before);

    if (input.edits.length === 1) {
      const [edit] = input.edits as [TextEdit];
      const single = { path: input.path, expectedRevision: input.expectedRevision, ...edit };
      const realSingle = await expectWorkspaceError(editTextFile(guard, options, single), real.code);
      const drySingle = await expectWorkspaceError(previewEditTextFile(guard, options, single), real.code);
      expect(drySingle.message).toBe(realSingle.message);
    }
  });

  it('names the file by its workspace-relative path in the diff', async () => {
    const preview = await previewEditTextFile(guard, readWrite, {
      path: 'src/index.ts',
      oldString: 'export',
      newString: 'import',
      expectedRevision: await revisionOf('src/index.ts'),
      replaceAll: false,
    });
    expect(preview.diff).toBe('--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export {};\n+import {};\n');
    expectNoHostPath(preview.diff, fixture);
  });
});
