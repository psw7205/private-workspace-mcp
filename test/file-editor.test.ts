import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editTextFile } from '../src/filesystem/file-editor.js';
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
    ['link-outside-dir/secret.txt', 'PATH_OUTSIDE_WORKSPACE'],
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
