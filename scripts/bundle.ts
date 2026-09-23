/**
 * Builds the release artifact: one ESM file that runs on Node 26 without node_modules.
 *
 *   release/index.mjs, index.mjs.map   src/index.ts with its runtime dependencies inlined
 *   release/THIRD_PARTY_LICENSES.txt   license text of every bundled package
 *   release/SHA256SUMS                 checksums in `shasum -a 256 -c` format
 *
 * Run with `pnpm bundle`.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'release');

/** Package directories (relative to the project root) that contributed code to the bundle. */
function bundledPackageDirs(metafile: Metafile): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match?.[1]) dirs.add(match[1]);
  }
  return [...dirs];
}

async function thirdPartyLicenses(packageDirs: string[]): Promise<string> {
  const sections: Array<{ name: string; text: string }> = [];
  for (const dir of packageDirs) {
    const absDir = path.join(projectRoot, dir);
    const pkg = JSON.parse(await readFile(path.join(absDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
    };
    const licenseFiles = (await readdir(absDir)).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort();
    // Redistributing bundled code requires its notice; refuse to ship without one.
    if (licenseFiles.length === 0) throw new Error(`${pkg.name}@${pkg.version} has no license file`);
    const texts = await Promise.all(licenseFiles.map((file) => readFile(path.join(absDir, file), 'utf8')));
    sections.push({
      name: pkg.name,
      text: `${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})\n\n${texts.map((text) => text.trim()).join('\n\n')}\n`,
    });
  }
  sections.sort((a, b) => a.name.localeCompare(b.name));
  return sections.map((section) => section.text).join(`\n${'-'.repeat(72)}\n\n`);
}

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  const { metafile } = await build({
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
  });

  const packageDirs = bundledPackageDirs(metafile);
  await writeFile(path.join(outDir, 'THIRD_PARTY_LICENSES.txt'), await thirdPartyLicenses(packageDirs));

  const files = (await readdir(outDir)).sort();
  const sums: string[] = [];
  for (const file of files) {
    const content = await readFile(path.join(outDir, file));
    // The artifact is published; it must not carry the build machine's paths.
    if (content.includes(projectRoot)) throw new Error(`release/${file} contains the build machine's project path`);
    sums.push(`${createHash('sha256').update(content).digest('hex')}  ${file}\n`);
  }
  await writeFile(path.join(outDir, 'SHA256SUMS'), sums.join(''));

  console.log(`bundled ${packageDirs.length} packages into release/: ${[...files, 'SHA256SUMS'].join(', ')}`);
}

main().catch((error: unknown) => {
  console.error('[bundle] FAIL', error);
  process.exitCode = 1;
});
