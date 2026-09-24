/**
 * Builds the release artifact: one ESM file that runs on Node 26 without node_modules.
 *
 *   release/index.mjs, index.mjs.map   src/index.ts with its runtime dependencies inlined
 *   release/THIRD_PARTY_LICENSES.txt   license text of every bundled package, including ones
 *                                      pre-bundled inside a dependency's dist
 *   release/SHA256SUMS                 checksums in `shasum -a 256 -c` format
 *
 * Run with `pnpm bundle`.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type BuildOptions, type Metafile } from 'esbuild';

import { type DetectedPackage, detectPackages, thirdPartyLicenses } from './third-party-licenses.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'release');
export const noticesDir = path.join(projectRoot, 'scripts', 'third-party-notices');

export const releaseBuildOptions = {
  absWorkingDir: projectRoot,
  entryPoints: ['src/index.ts'],
  outfile: 'release/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
} satisfies BuildOptions;

/**
 * Packages whose code is in the bundle. Metafile inputs are relative to the project root and map
 * sources to the map's directory. The map also lists what upstream dist files had inlined before
 * esbuild saw them (M51).
 */
export function bundledPackages(metafile: Metafile, mapText: string): DetectedPackage[] {
  const map = JSON.parse(mapText) as { sourceRoot?: string; sources: string[] };
  return detectPackages([
    ...Object.keys(metafile.inputs).map((input) => path.resolve(projectRoot, input)),
    ...map.sources.map((source) => path.resolve(outDir, map.sourceRoot ?? '', source)),
  ]);
}

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  const { metafile } = await build(releaseBuildOptions);
  const packages = bundledPackages(metafile, await readFile(path.join(outDir, 'index.mjs.map'), 'utf8'));
  await writeFile(path.join(outDir, 'THIRD_PARTY_LICENSES.txt'), await thirdPartyLicenses(packages, noticesDir));

  const files = (await readdir(outDir)).sort();
  const sums: string[] = [];
  for (const file of files) {
    const content = await readFile(path.join(outDir, file));
    // The artifact is published; it must not carry the build machine's paths.
    if (content.includes(projectRoot)) throw new Error(`release/${file} contains the build machine's project path`);
    sums.push(`${createHash('sha256').update(content).digest('hex')}  ${file}\n`);
  }
  await writeFile(path.join(outDir, 'SHA256SUMS'), sums.join(''));

  console.log(`bundled ${packages.length} packages into release/: ${[...files, 'SHA256SUMS'].join(', ')}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[bundle] FAIL', error);
    process.exitCode = 1;
  });
}
