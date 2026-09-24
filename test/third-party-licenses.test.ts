import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { bundledPackages, noticesDir, releaseBuildOptions } from '../scripts/bundle.js';
import { detectPackages, packageFromSourcePath, thirdPartyLicenses } from '../scripts/third-party-licenses.js';
import { createFixture, type Fixture } from './helpers.js';

describe('packageFromSourcePath', () => {
  it('reads the innermost package and its pnpm version', () => {
    expect(packageFromSourcePath('/p/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js')).toEqual({
      name: 'zod',
      version: '4.6.5',
      root: '/p/node_modules/.pnpm/zod@4.6.5/node_modules/zod',
    });
    expect(
      packageFromSourcePath('/p/node_modules/.pnpm/@modelcontextprotocol+core@2.0.0/node_modules/@modelcontextprotocol/core/dist/a.mjs'),
    ).toMatchObject({ name: '@modelcontextprotocol/core', version: '2.0.0' });
  });

  it('reads packages pre-bundled inside a dependency, dropping pnpm peer suffixes', () => {
    const host = '/p/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules';
    expect(
      packageFromSourcePath(`${host}/node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.18.0/node_modules/ajv-formats/dist/index.js`),
    ).toMatchObject({ name: 'ajv-formats', version: '3.0.1' });
    // The enclosing pnpm directory names the host, not this package: the version is unknown.
    expect(packageFromSourcePath(`${host}/@modelcontextprotocol/core-internal/src/types.ts`)).toMatchObject({
      name: '@modelcontextprotocol/core-internal',
      version: undefined,
    });
  });

  it('ignores first-party files', () => {
    expect(packageFromSourcePath('/p/src/index.ts')).toBeUndefined();
  });
});

describe('thirdPartyLicenses', () => {
  let fixture: Fixture | undefined;
  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  async function installed(name: string, files: Record<string, string>): Promise<string> {
    fixture ??= await createFixture();
    const root = path.join(fixture.root, 'node_modules', name);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
    return path.join(root, 'index.js');
  }

  it('uses installed license files and vendored notices for pre-bundled packages', async () => {
    const own = await installed('own-dep', { LICENSE: 'own license' });
    const text = await thirdPartyLicenses(
      detectPackages([own, '/p/node_modules/x/node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js']),
      noticesDir,
    );
    expect(text).toContain('own-dep@1.0.0 (MIT)\n\nown license\n');
    expect(text).toContain('fast-uri@3.1.0 (BSD-3-Clause)');
    expect(text).toContain('Redistributions in binary form must reproduce');
  });

  it('fails for a bundled package without a license text', async () => {
    await expect(
      thirdPartyLicenses(detectPackages(['/p/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js']), noticesDir),
    ).rejects.toThrow('left-pad@1.3.0 is bundled but has no license text');
    // A vendored notice is keyed by exact version.
    await expect(
      thirdPartyLicenses(detectPackages(['/p/node_modules/.pnpm/ajv@8.99.0/node_modules/ajv/index.js']), noticesDir),
    ).rejects.toThrow('ajv@8.99.0 is bundled but has no license text');
    await expect(thirdPartyLicenses(detectPackages([await installed('bare', {})]), noticesDir)).rejects.toThrow(
      'bare@1.0.0 has no license file',
    );
  });

  it('covers a package shipped inside its host only when the host is bundled', async () => {
    const internal = '/p/node_modules/.pnpm/h@1.0.0/node_modules/@modelcontextprotocol/core-internal/src/a.ts';
    await expect(thirdPartyLicenses(detectPackages([internal]), noticesDir)).rejects.toThrow(
      'bundled without @modelcontextprotocol/server',
    );
  });

  // Catches a dependency upgrade that inlines a package with no license text, before release time.
  it('has a license text for every package in the release bundle', async () => {
    const { metafile, outputFiles } = await build({ ...releaseBuildOptions, write: false });
    const map = outputFiles.find((file) => file.path.endsWith('.map'));
    if (!map) throw new Error('no source map in build output');
    const packages = bundledPackages(metafile, map.text);
    expect(packages.map((pkg) => pkg.name)).toEqual(expect.arrayContaining(['ajv', 'fast-uri', 'zod']));
    const text = await thirdPartyLicenses(packages, noticesDir);
    expect(text).toContain('Also covers @modelcontextprotocol/core-internal');
  });
});
