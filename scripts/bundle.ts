/**
 * Builds the release artifact: one ESM file that runs on Node 26 without node_modules.
 *
 *   release/index.mjs, index.mjs.map   src/index.ts with its runtime dependencies inlined and
 *                                      `SERVER_BUILD` set to the checkout's commit (M84)
 *   release/THIRD_PARTY_LICENSES.txt   license text of every bundled package, including ones
 *                                      pre-bundled inside a dependency's dist
 *   release/SHA256SUMS                 checksums in `shasum -a 256 -c` format
 *
 * Run with `pnpm bundle` in a Git checkout.
 */
import { execFileSync } from 'node:child_process';
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

function git(cwd: string, ...args: string[]): string {
  // stderr is piped so a failure reports it once, inside the thrown error's message.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** HEAD and the uncommitted changes to tracked files. Untracked files are ignored, so `pnpm install:local` and the bundle agree on clean. */
export function checkoutState(cwd = projectRoot): { commit: string; changes: string } {
  return { commit: git(cwd, 'rev-parse', '--short=12', 'HEAD'), changes: git(cwd, 'status', '--porcelain', '--untracked-files=no') };
}

/** The `SERVER_BUILD` a bundle of this checkout carries: the commit, with `-dirty` when tracked files have changes. */
export function serverBuild(cwd = projectRoot): string {
  const { commit, changes } = checkoutState(cwd);
  return changes === '' ? commit : `${commit}-dirty`;
}

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
  // The global is declared in src/server/server.ts. Outside a Git checkout this throws before release/ is touched.
  const define = { __SERVER_BUILD__: JSON.stringify(serverBuild()) };
  await rm(outDir, { recursive: true, force: true });
  const { metafile } = await build({ ...releaseBuildOptions, define });
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
