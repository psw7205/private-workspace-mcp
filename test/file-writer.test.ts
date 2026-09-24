import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTextFile } from '../src/filesystem/file-reader.js';
import { writeTextFile } from '../src/filesystem/file-writer.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { computeRevision } from '../src/filesystem/revision.js';
import { WorkspaceError } from '../src/errors/errors.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, GatedGuard, type Fixture } from './helpers.js';

const readWrite = { mode: 'read-write', maxReadBytes: 64, maxWriteBytes: 32 } as const;

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
    const readOnly = { mode: 'read-only', maxReadBytes: 64, maxWriteBytes: 32 } as const;
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
    expect(await readFile(path.join(fixture.outside, 'private.txt'), 'utf8')).toBe('outside secret\n');
  });

  it('does not create files through a symlinked directory that points outside', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'link-outside-dir/new.txt', content: 'pwned' }),
      'PATH_OUTSIDE_WORKSPACE',
    );
    expect(await readdir(fixture.outside)).toEqual(['private.txt']);
  });

  it('does not create directories through a dangling symlink', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, { path: 'link-dangling/new.txt', content: 'pwned' }),
      'INVALID_PATH',
    );
    expect(await readdir(fixture.outside)).toEqual(['private.txt']);
  });

  it.each(['.env', 'config/.env.local', '.git/hooks/pre-commit', 'certs/tls.key'])(
    'blocks denied target %j',
    async (input) => {
      await expectWorkspaceError(writeTextFile(guard, readWrite, { path: input, content: 'x' }), 'PATH_BLOCKED');
    },
  );

  // read_file never returns a revision for such a file, so hashing it could only burn IO.
  it('refuses to replace a file over the read limit, even with its revision', async () => {
    const original = 'x'.repeat(65);
    await writeFile(inRoot('large.txt'), original);
    const error = await expectWorkspaceError(
      writeTextFile(guard, readWrite, {
        path: 'large.txt',
        content: 'small',
        expectedRevision: computeRevision(Buffer.from(original)),
      }),
      'FILE_TOO_LARGE',
    );
    expectNoHostPath(error.message, fixture);
    expect(await readFile(inRoot('large.txt'), 'utf8')).toBe(original);
  });

  // Buffer.from would encode a lone surrogate as U+FFFD, so the file would not hold what was sent.
  it('rejects content that is not well-formed Unicode', async () => {
    await expectWorkspaceError(writeTextFile(guard, readWrite, { path: 'lone.txt', content: 'a\ud800b' }), 'BINARY_FILE');
    await expect(stat(inRoot('lone.txt'))).rejects.toThrow();
  });

  it('reports a missing file instead of creating it when the file must exist', async () => {
    await expectWorkspaceError(
      writeTextFile(guard, readWrite, {
        path: 'gone.md',
        content: 'x',
        expectedRevision: computeRevision(Buffer.from('x')),
        mustExist: true,
      }),
      'FILE_NOT_FOUND',
    );
  });

  it('rejects a directory target', async () => {
    await expectWorkspaceError(writeTextFile(guard, readWrite, { path: 'src', content: 'x' }), 'NOT_A_FILE');
  });

  it.skipIf(process.platform === 'win32').each([
    ['0755', 0o755],
    ['0600', 0o600],
  ])('preserves mode %s of an overwritten file', async (_label, mode) => {
    await chmod(inRoot('README.md'), mode);
    const revision = computeRevision(await readFile(inRoot('README.md')));
    await writeTextFile(guard, readWrite, { path: 'README.md', content: '#!/bin/sh\n', expectedRevision: revision });
    expect((await stat(inRoot('README.md'))).mode & 0o777).toBe(mode);
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

describe('writeTextFile after its signal aborts (M43)', () => {
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
  const tempFiles = async () => (await readdir(fixture.root)).filter((name) => name.startsWith('.pwmcp-'));

  it('writes nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { ...readWrite, signal: controller.signal };
    const revision = computeRevision(await readFile(inRoot('README.md')));

    await expect(
      writeTextFile(guard, options, { path: 'README.md', content: 'late', expectedRevision: revision }),
    ).rejects.toThrow();
    await expect(writeTextFile(guard, options, { path: 'docs/new.md', content: 'late' })).rejects.toThrow();

    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
    await expect(stat(inRoot('docs'))).rejects.toThrow();
    expect(await tempFiles()).toEqual([]);
  });

  it('does not commit when the signal aborts after the lock is taken', async () => {
    const gated = new GatedGuard(fixture.realRoot);
    const controller = new AbortController();
    const revision = computeRevision(await readFile(inRoot('README.md')));
    const write = writeTextFile(
      gated,
      { ...readWrite, signal: controller.signal },
      { path: 'README.md', content: 'late', expectedRevision: revision },
    );
    // Past the lock-acquired check; the revision check still passes, so only the commit check can stop it.
    await gated.entered;
    controller.abort();
    gated.open();

    await expect(write).rejects.toThrow();
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('# readme\n');
    expect(await tempFiles()).toEqual([]);
  });

  it('does not commit a write whose signal aborts while it waits for the path lock', async () => {
    const slow = new GatedGuard(fixture.realRoot);
    const original = computeRevision(await readFile(inRoot('README.md')));
    const first = writeTextFile(slow, readWrite, { path: 'README.md', content: 'first', expectedRevision: original });
    await slow.entered;

    const waiting = new GatedGuard(fixture.realRoot);
    waiting.open();
    const controller = new AbortController();
    // Valid after the first write, so this write would succeed if its signal had not aborted.
    const queued = writeTextFile(
      waiting,
      { ...readWrite, signal: controller.signal },
      { path: 'README.md', content: 'queued', expectedRevision: computeRevision(Buffer.from('first')) },
    );
    await waiting.lockKeyResolved;
    // Let the write queue behind the lock holder before aborting.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    slow.open();

    await expect(first).resolves.toMatchObject({ created: false });
    await expect(queued).rejects.toThrow();
    expect(await readFile(inRoot('README.md'), 'utf8')).toBe('first');
    expect(await tempFiles()).toEqual([]);
  });
});
