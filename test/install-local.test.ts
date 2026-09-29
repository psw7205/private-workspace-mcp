import { mkdir, mkdtemp, readdir, readlink, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installRelease } from '../scripts/install-local.js';

describe.skipIf(process.platform === 'win32')('installRelease', () => {
  let base: string;
  let releaseDir: string;
  let installDir: string;
  const ok = () => {};

  async function writeRelease(content: string): Promise<void> {
    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, 'index.mjs'), content);
    await writeFile(path.join(releaseDir, 'SHA256SUMS'), `sum-of ${content}\n`);
  }

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'pwmcp-install-'));
    releaseDir = path.join(base, 'release');
    installDir = path.join(base, 'install', 'private-workspace-mcp');
    await writeRelease('build-a');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('copies the release into a named directory and points current at it', async () => {
    const result = await installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok });

    expect(result).toEqual({ target: path.join(installDir, 'v1.0.0-aaa'), previous: undefined, reused: false });
    expect(await readlink(path.join(installDir, 'current'))).toBe('v1.0.0-aaa');
    expect(await readFile(path.join(installDir, 'current', 'index.mjs'), 'utf8')).toBe('build-a');
  });

  it('reports the previous target so it can be rolled back to', async () => {
    await installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok });
    await writeRelease('build-b');
    const result = await installRelease({ releaseDir, installDir, name: 'v1.0.0-bbb', verify: ok });

    expect(result.previous).toBe('v1.0.0-aaa');
    expect(await readlink(path.join(installDir, 'current'))).toBe('v1.0.0-bbb');
    expect(await readFile(path.join(installDir, 'v1.0.0-aaa', 'index.mjs'), 'utf8')).toBe('build-a');
  });

  it('leaves current and the install dir untouched when verification fails', async () => {
    await installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok });
    await writeRelease('build-b');
    const verify = () => {
      throw new Error('wrong version');
    };

    await expect(installRelease({ releaseDir, installDir, name: 'v1.0.0-bbb', verify })).rejects.toThrow('wrong version');
    expect(await readlink(path.join(installDir, 'current'))).toBe('v1.0.0-aaa');
    expect((await readdir(installDir)).sort()).toEqual(['current', 'v1.0.0-aaa']);
  });

  it('reuses an identical install of the same name and rejects a different one', async () => {
    await installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok });
    expect((await installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok })).reused).toBe(true);

    await writeRelease('build-b');
    await expect(installRelease({ releaseDir, installDir, name: 'v1.0.0-aaa', verify: ok })).rejects.toThrow(
      'already exists with different content',
    );
    expect(await readFile(path.join(installDir, 'current', 'index.mjs'), 'utf8')).toBe('build-a');
  });
});
