import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listDirectory } from '../src/filesystem/directory-lister.js';
import { readTextFile } from '../src/filesystem/file-reader.js';
import { findFiles, searchText } from '../src/filesystem/file-search.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, type Fixture } from './helpers.js';

// Host file names that contain line terminators and otherwise match a deny pattern (M64).
// Windows does not allow control characters in file names.
describe.skipIf(process.platform === 'win32')('deny list with line terminators in host names', () => {
  let fixture: Fixture;
  let guard: PathGuard;
  const options = { maxSearchFiles: 100, maxReadBytes: 1024 };

  beforeAll(async () => {
    fixture = await createFixture();
    guard = new PathGuard(fixture.realRoot);
    const names = path.join(fixture.root, 'names');
    await mkdir(names);
    await writeFile(path.join(names, 'ok.txt'), 'needle-ok\n');
    await writeFile(path.join(names, 'secret\nx.txt'), 'needle-nl\n');
    await writeFile(path.join(names, 'secret\rx.txt'), 'needle-cr\n');
    await writeFile(path.join(names, 'secret x.txt'), 'needle-ls\n');
    await writeFile(path.join(names, 'server\n.pem'), 'needle-pem\n');
    await mkdir(path.join(names, 'secret\ndir'));
    await writeFile(path.join(names, 'secret\ndir/inner.txt'), 'needle-dir\n');
    await symlink('secret\nx.txt', path.join(names, 'alias'));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('omits them from list_directory', async () => {
    const result = await listDirectory(guard, { path: 'names', depth: 3, limit: 100 });
    expect(result.entries.map((entry) => entry.path)).toEqual(['names/alias', 'names/ok.txt']);
  });

  it('omits them from find_files', async () => {
    const result = await findFiles(guard, options, { path: 'names', pattern: '**', limit: 100, includeIgnored: true });
    expect(result.files.map((file) => file.path)).toEqual(['names/ok.txt']);
  });

  it('does not search their content', async () => {
    const result = await searchText(guard, options, {
      path: 'names',
      query: 'needle',
      caseSensitive: false,
      includeIgnored: true,
      limit: 100,
      regex: false,
    });
    expect(result.matches.map((match) => match.path)).toEqual(['names/ok.txt']);
  });

  it('rejects a name with a control character as input', async () => {
    const error = await expectWorkspaceError(readTextFile(guard, options, { path: 'names/secret\nx.txt' }), 'INVALID_PATH');
    expectNoHostPath(error.message, fixture);
  });

  it('blocks reading one by a name that input validation accepts', async () => {
    const error = await expectWorkspaceError(readTextFile(guard, options, { path: 'names/secret x.txt' }), 'PATH_BLOCKED');
    expectNoHostPath(error.message, fixture);
  });

  it('blocks reading one through a symlink', async () => {
    const error = await expectWorkspaceError(readTextFile(guard, options, { path: 'names/alias' }), 'PATH_BLOCKED');
    expectNoHostPath(error.message, fixture);
  });
});
