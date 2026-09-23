import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTextFile } from '../src/filesystem/file-reader.js';
import { writeTextFile } from '../src/filesystem/file-writer.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { computeRevision } from '../src/filesystem/revision.js';
import { WorkspaceError } from '../src/errors/errors.js';
import { createFixture, expectWorkspaceError, type Fixture } from './helpers.js';

const readWrite = { mode: 'read-write', maxWriteBytes: 32 } as const;

describe('writeTextFile', () => {
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

  it('refuses every write in read-only mode', async () => {
    const readOnly = { mode: 'read-only', maxWriteBytes: 32 } as const;
    await expectWorkspaceError(writeTextFile(guard, readOnly, { path: 'new.txt', content: 'x' }), 'READ_ONLY');
    const revision = computeRevision(await readFile(inRoot('README.md')));
    await expectWorkspaceError(
      writeTextFile(guard, readOnly, { path: 'README.md', content: 'x', expectedRevision: revision }),
      'READ_ONLY',
    );
    await expect(stat(inRoot('new.txt'))).rejects.toThrow();
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('creates a new file', async () => {
    const result = await writeTextFile(guard, readWrite, { path: 'notes.md', content: 'hello\n' });
    expect(result).toEqual({
      path: 'notes.md',
      created: true,
      bytes_written: 6,
      revision: computeRevision(Buffer.from('hello\n')),
    });
    expect(await readFile(inRoot('notes.md'), 'utf8')).toBe('hello\n');
  });

  it('creates missing parent directories inside the workspace', async () => {
    await writeTextFile(guard, readWrite, { path: 'docs/adr/002.md', content: '# 002\n' });
    expect(await readFile(inRoot('docs/adr/002.md'), 'utf8')).toBe('# 002\n');
  });

  it('refuses to create over an existing file without a revision', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'README.md', content: 'clobber' }),
      'REVISION_CONFLICT',
    );
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
  });

  it('overwrites when the expected revision matches', async () => {
    const { revision } = await readTextFile(guard, { maxReadBytes: 1024 }, { path: 'README.md' });
    const result = await writeTextFile(guard, readWrite, {
      path: 'README.md',
      content: '# updated\n',
      expectedRevision: revision,
    });
    expect(result).toMatchObject({ created: false, revision: computeRevision(Buffer.from('# updated\n')) });
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# updated\n');
  });

  it('rejects a stale revision after a concurrent user edit', async () => {
    const { revision } = await readTextFile(guard, { maxReadBytes: 1024 }, { path: 'README.md' });
    await writeFile(inRoot('README.md'), '# user edit\n');
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'README.md', content: '# agent\n', expectedRevision: revision }),
      'REVISION_CONFLICT',
    );
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# user edit\n');
  });

  it('rejects an expected revision for a file that no longer exists', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'gone.md', content: 'x', expectedRevision: computeRevision(Buffer.from('x')) }),
      'REVISION_CONFLICT',
    );
    await expect(stat(inRoot('gone.md'))).rejects.toThrow();
  });

  it('lets exactly one of two concurrent writes with the same revision win', async () => {
    const revision = computeRevision(await readFile(inRoot('README.md')));
    const results = await Promise.allSettled([
      writeTextFile(guard, readWrite, { path: 'README.md', content: 'first\n', expectedRevision: revision }),
      writeTextFile(guard, readWrite, { path: 'README.md', content: 'second\n', expectedRevision: revision }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceError);
    expect(((rejected[0] as PromiseRejectedResult).reason as WorkspaceError).code).toBe('REVISION_CONFLICT');
  });

  it('lets exactly one of two concurrent creates win', async () => {
    const results = await Promise.allSettled([
      writeTextFile(guard, readWrite, { path: 'race.txt', content: 'a' }),
      writeTextFile(guard, readWrite, { path: 'race.txt', content: 'b' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('enforces the write limit in UTF-8 bytes', async () => {
    // 11 Hangul syllables = 33 bytes > 32
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'big.txt', content: '가'.repeat(11) }),
      'FILE_TOO_LARGE',
    );
    await expect(stat(inRoot('big.txt'))).rejects.toThrow();
  });

  it('does not write through a symlink that points outside', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'link-outside-file', content: 'pwned' }),
      'INVALID_PATH',
    );
    expect(await readFile(path.join(fixture.outside, 'secret.txt'), 'utf8')).toBe('outside secret\n');
  });

  it('does not create files through a symlinked directory that points outside', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'link-outside-dir/new.txt', content: 'pwned' }),
      'PATH_OUTSIDE_WORKSPACE',
    );
    expect(await readdir(fixture.outside)).toEqual(['secret.txt']);
  });

  it('does not create directories through a dangling symlink', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'link-dangling/new.txt', content: 'pwned' }),
      'INVALID_PATH',
    );
    expect(await readdir(fixture.outside)).toEqual(['secret.txt']);
  });

  it.each(['.env', 'config/.env.local', '.git/hooks/pre-commit', 'certs/tls.key'])(
    'blocks denied target %j',
    async (input) => {
      await expectWorkspaceError(writeTextFile(guard, readWrite, { path: input, content: 'x' }), 'PATH_BLOCKED');
    },
  );

  it('rejects a directory target', async () => {
    await expectWorkspaceError(writeTextFile(guard, readWrite, { path: 'src', content: 'x' }), 'NOT_A_FILE');
  });

  it.skipIf(process.platform === 'win32')('preserves the mode of an overwritten file', async () => {
    await chmod(inRoot('README.md'), 0o755);
    const revision = computeRevision(await readFile(inRoot('README.md')));
    await writeTextFile(guard, readWrite, { path: 'README.md', content: '#!/bin/sh\n', expectedRevision: revision });
    expect((await stat(inRoot('README.md'))).mode & 0o777).toBe(0o755);
  });

  it('leaves no temporary files behind on success or conflict', async () => {
    await writeTextFile(guard, readWrite, { path: 'src/a.ts', content: 'a' });
    await writeTextFile(guard, readWrite, { path: 'src/a.ts', content: 'b' }).catch(() => undefined);
    await writeTextFile(guard, readWrite, {
      path: 'src/index.ts',
      content: 'c',
      expectedRevision: computeRevision(Buffer.from('stale')),
    }).catch(() => undefined);
    expect((await readdir(inRoot('src'))).sort()).toEqual(['a.ts', 'index.ts']);
  });
});
