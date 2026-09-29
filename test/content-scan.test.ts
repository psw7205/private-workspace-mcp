import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listDirectory } from '../src/filesystem/directory-lister.js';
import {
  editTextFile,
  editTextFileMulti,
  previewEditTextFile,
  previewEditTextFileMulti,
} from '../src/filesystem/file-editor.js';
import { readTextFile } from '../src/filesystem/file-reader.js';
import { findFiles, searchText, type SearchTextParams } from '../src/filesystem/file-search.js';
import { writeTextFile } from '../src/filesystem/file-writer.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { isDenied } from '../src/policy/deny-list.js';
import { computeRevision } from '../src/filesystem/revision.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, FAKE_CREDENTIALS, type Fixture } from './helpers.js';

const KEY = FAKE_CREDENTIALS.openai;
// The key sits on line 3, so a window of lines 1-2 would not include it.
const BACKUP = `{\n  "name": "archive",\n  "API_KEY": "${KEY}"\n}\n`;
const BLOCKED_MESSAGE = 'data/backup.json is blocked by the sensitive file policy';

const limits = { maxReadBytes: 4096 };
const searchOptions = { maxSearchFiles: 100, maxReadBytes: 4096 };
const readWrite = { mode: 'read-write', maxReadBytes: 4096, maxWriteBytes: 4096 } as const;

describe('content scan (ADR-010)', () => {
  let fixture: Fixture;
  let guard: PathGuard;

  beforeEach(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    await mkdir(path.join(fixture.root, 'data'));
    await writeFile(path.join(fixture.root, 'data/backup.json'), BACKUP);
    await writeFile(path.join(fixture.root, 'data/plain.json'), '{\n  "API_KEY": "from-env"\n}\n');
    // Ignored, like the archive in the incident: include_ignored must not bypass the scan.
    await writeFile(path.join(fixture.root, '.gitignore'), 'data/ignored.json\n');
    await writeFile(path.join(fixture.root, 'data/ignored.json'), BACKUP);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const inRoot = (relative: string) => path.join(fixture.root, relative);
  const revisionOf = async (relative: string) => computeRevision(await readFile(inRoot(relative)));
  const expectBlocked = async (promise: Promise<unknown>) => {
    const error = await expectWorkspaceError(promise, 'PATH_BLOCKED');
    expect(error.message).toBe(BLOCKED_MESSAGE);
    expect(error.detail).toBe('content:openai');
    expect(error.message).not.toContain(KEY);
    expectNoHostPath(error.message, fixture);
  };

  describe('read_file', () => {
    it('refuses a file whose name is not denied but whose content holds a credential', async () => {
      await expectBlocked(readTextFile(guard, limits, { path: 'data/backup.json' }));
    });

    it('scans the whole file, not just the requested window', async () => {
      await expectBlocked(readTextFile(guard, limits, { path: 'data/backup.json', startLine: 1, maxLines: 2 }));
      await expectBlocked(readTextFile(guard, limits, { path: 'data/backup.json', startLine: 5 }));
    });

    it.each(Object.entries(FAKE_CREDENTIALS))('blocks %s', async (id, value) => {
      await writeFile(inRoot('data/notes.md'), `# notes\n\n${value}\n`);
      const error = await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/notes.md' }), 'PATH_BLOCKED');
      expect(error.detail).toBe(`content:${id}`);
    });

    it('keeps the earlier checks: too large and binary files are rejected as before', async () => {
      await writeFile(inRoot('data/big.json'), `${KEY}\n${'x'.repeat(4096)}`);
      await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/big.json' }), 'FILE_TOO_LARGE');
      await writeFile(inRoot('data/key.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY)]));
      await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/key.bin' }), 'BINARY_FILE');
    });

    it('reads the file when the scan is turned off', async () => {
      const unscanned = new PathGuard(fixture.realRoot, isDenied, false);
      expect((await readTextFile(unscanned, limits, { path: 'data/backup.json' })).content).toBe(BACKUP);
    });
  });

  describe('search_text', () => {
    const search = (params: Partial<SearchTextParams> & { query: string }, searchGuard = guard) =>
      searchText(searchGuard, searchOptions, {
        path: '.',
        caseSensitive: false,
        includeIgnored: false,
        limit: 100,
        regex: false,
        ...params,
      });

    it('skips a blocked file without failing the search and counts it for the audit', async () => {
      const result = await search({ query: 'API_KEY' });
      expect(result.matches.map((match) => match.path)).toEqual(['data/plain.json']);
      expect(result.files_searched).toBe(4);
      expect(result.contentBlocked).toBe(1);
      expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it('skips blocked files that include_ignored brings in', async () => {
      const result = await search({ query: 'API_KEY', includeIgnored: true });
      expect(result.matches.map((match) => match.path)).toEqual(['data/plain.json']);
      expect(result.contentBlocked).toBe(2);
    });

    it('gives no match oracle over the blocked content', async () => {
      // Each probe would confirm one more character of the key if the blocked file were matched.
      const line = `  "API_KEY": "${KEY}"`;
      const probe = `^.{${line.indexOf(KEY) + 3}}${KEY.charAt(3)}`;
      for (const query of [probe, KEY.slice(0, 12)]) {
        for (const regex of [true, false]) {
          const result = await search({ query, regex, caseSensitive: true, includeIgnored: true });
          expect(result.matches, `${query} regex=${regex}`).toEqual([]);
        }
      }
    });

    it('searches the file when the scan is turned off', async () => {
      const unscanned = new PathGuard(fixture.realRoot, isDenied, false);
      const result = await search({ query: KEY.slice(0, 12), caseSensitive: true }, unscanned);
      expect(result.matches.map((match) => match.path)).toEqual(['data/backup.json']);
      expect(result.contentBlocked).toBe(0);
    });

    it('does not scan the ignore files the walk reads', async () => {
      await writeFile(inRoot('.gitignore'), `# ${KEY}\ndata/ignored.json\n`);
      const result = await search({ query: 'from-env' });
      expect(result.matches.map((match) => match.path)).toEqual(['data/plain.json']);
    });
  });

  describe('listing', () => {
    it('still lists and finds a blocked file (ADR-010 §3.4)', async () => {
      const listed = await listDirectory(guard, { path: 'data', depth: 1, limit: 100 });
      expect(listed.entries.map((entry) => entry.path)).toContain('data/backup.json');
      const found = await findFiles(guard, searchOptions, { path: '.', pattern: '**/*.json', limit: 100, includeIgnored: false });
      expect(found.files.map((file) => file.path)).toContain('data/backup.json');
    });
  });

  describe('edit tools', () => {
    const edits = [
      ['a matching edit', 'archive', 'x'],
      ['a missing old_string', 'not in the file', 'x'],
      ['an old_string that probes the key', KEY.slice(0, 12), 'x'],
    ] as const;

    it.each(edits)('refuses %s, dry run or not, without touching the file', async (_, oldString, newString) => {
      const params = { path: 'data/backup.json', oldString, newString, replaceAll: false, expectedRevision: await revisionOf('data/backup.json') };
      await expectBlocked(previewEditTextFile(guard, readWrite, params));
      await expectBlocked(editTextFile(guard, readWrite, params));
      const multi = { path: params.path, edits: [params], expectedRevision: params.expectedRevision };
      await expectBlocked(previewEditTextFileMulti(guard, readWrite, multi));
      await expectBlocked(editTextFileMulti(guard, readWrite, multi));
      expect(await readFile(inRoot('data/backup.json'), 'utf8')).toBe(BACKUP);
    });

    it('scans before the revision check', async () => {
      const params = { path: 'data/backup.json', oldString: 'archive', newString: 'x', replaceAll: false, expectedRevision: computeRevision(Buffer.from('stale')) };
      await expectBlocked(editTextFile(guard, readWrite, params));
    });

    it('allows an edit that introduces a credential; the next read is blocked', async () => {
      const result = await editTextFile(guard, readWrite, {
        path: 'data/plain.json',
        oldString: 'from-env',
        newString: KEY,
        replaceAll: false,
        expectedRevision: await revisionOf('data/plain.json'),
      });
      expect(result.replacements).toBe(1);
      await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/plain.json' }), 'PATH_BLOCKED');
    });

    it('edits the file when the scan is turned off', async () => {
      const unscanned = new PathGuard(fixture.realRoot, isDenied, false);
      const params = { path: 'data/backup.json', oldString: 'archive', newString: 'x', replaceAll: false, expectedRevision: await revisionOf('data/backup.json') };
      expect((await previewEditTextFile(unscanned, readWrite, params)).replacements).toBe(1);
    });
  });

  describe('write_file', () => {
    it('refuses to replace a blocked file, before the revision check', async () => {
      for (const expectedRevision of [await revisionOf('data/backup.json'), computeRevision(Buffer.from('stale'))]) {
        await expectBlocked(writeTextFile(guard, readWrite, { path: 'data/backup.json', content: '{}\n', expectedRevision }));
      }
      expect(await readFile(inRoot('data/backup.json'), 'utf8')).toBe(BACKUP);
    });

    it('creates a new file with a credential, which then cannot be read', async () => {
      const result = await writeTextFile(guard, readWrite, { path: 'data/new.env.json', content: BACKUP });
      expect(result.created).toBe(true);
      await expectWorkspaceError(readTextFile(guard, limits, { path: 'data/new.env.json' }), 'PATH_BLOCKED');
    });

    it('still replaces a binary file, whose content is never scanned', async () => {
      await writeFile(inRoot('data/key.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY)]));
      const result = await writeTextFile(guard, readWrite, {
        path: 'data/key.bin',
        content: 'text\n',
        expectedRevision: await revisionOf('data/key.bin'),
      });
      expect(result.created).toBe(false);
    });
  });
});
