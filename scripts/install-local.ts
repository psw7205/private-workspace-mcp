/**
 * Installs the current checkout the same way a GitHub Release is installed, for running a daemon
 * from source:
 *
 *   <install-dir>/v<version>-<commit>/   index.mjs, index.mjs.map, THIRD_PARTY_LICENSES.txt, SHA256SUMS
 *   <install-dir>/current -> v<version>-<commit>
 *
 * The install dir is PRIVATE_WORKSPACE_MCP_INSTALL_DIR, or ~/.local/share/private-workspace-mcp.
 * Only a clean tracked tree that passes typecheck and test is installed, and `current` moves only
 * after the installed entry reports the package version and the commit. Run with `pnpm install:local`.
 * POSIX only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkoutState } from './bundle.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface InstallOptions {
  releaseDir: string;
  installDir: string;
  name: string;
  /** Throws if the staged entry is not the expected build. */
  verify: (entry: string) => void;
}

export interface InstallResult {
  target: string;
  previous: string | undefined;
  reused: boolean;
}

async function readSums(dir: string): Promise<string | undefined> {
  return readFile(path.join(dir, 'SHA256SUMS'), 'utf8').catch(() => undefined);
}

export async function installRelease({ releaseDir, installDir, name, verify }: InstallOptions): Promise<InstallResult> {
  await mkdir(installDir, { recursive: true });
  const target = path.join(installDir, name);
  const current = path.join(installDir, 'current');

  const existing = await readSums(target);
  let reused = false;
  if (existing !== undefined) {
    // The name pins a commit, so a different artifact under it means something else wrote there.
    if (existing !== (await readSums(releaseDir))) throw new Error(`${target} already exists with different content`);
    verify(path.join(target, 'index.mjs'));
    reused = true;
  } else {
    const staging = await mkdtemp(path.join(installDir, `.${name}-`));
    try {
      await cp(releaseDir, staging, { recursive: true });
      verify(path.join(staging, 'index.mjs'));
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  const previous = await readlink(current).catch(() => undefined);
  // rename() replaces the link atomically; `ln -sfn` unlinks first and leaves a moment with no `current`.
  const link = path.join(installDir, `.current-${process.pid}`);
  await rm(link, { force: true });
  await symlink(name, link, 'dir');
  await rename(link, current);
  return { target, previous, reused };
}

function pnpm(script: string): void {
  execFileSync('pnpm', [script], { cwd: projectRoot, stdio: 'inherit' });
}

/** `<version>+<build>` from the first `--check` line, the only CLI output that shows the build. */
function reportedLabel(entry: string): string {
  // `--check` needs a workspace; the checkout is one. Only WORKSPACE_ROOT is passed so the caller's WORKSPACE_* cannot fail it.
  const { status, stderr } = spawnSync(process.execPath, [entry, '--check'], { env: { WORKSPACE_ROOT: projectRoot }, encoding: 'utf8' });
  const label = /^private-workspace-mcp (\S+): configuration OK /.exec(stderr)?.[1];
  if (status !== 0 || label === undefined) throw new Error(`${entry} --check failed: ${stderr.trim()}`);
  return label;
}

async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('install:local supports macOS and Linux only');
  const { commit, changes } = checkoutState();
  if (changes !== '') throw new Error(`tracked files have uncommitted changes:\n${changes}`);

  const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
  pnpm('typecheck');
  pnpm('test');
  pnpm('bundle');

  const installDir = process.env.PRIVATE_WORKSPACE_MCP_INSTALL_DIR || path.join(homedir(), '.local', 'share', 'private-workspace-mcp');
  const { target, previous, reused } = await installRelease({
    releaseDir: path.join(projectRoot, 'release'),
    installDir,
    name: `v${version}-${commit}`,
    verify: (entry) => {
      const reported = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim();
      if (reported !== version) throw new Error(`${entry} reports version ${reported}, expected ${version}`);
      // A different build means HEAD or the tree changed while typecheck, test, and bundle ran.
      const label = reportedLabel(entry);
      if (label !== `${version}+${commit}`) throw new Error(`${entry} reports ${label}, expected ${version}+${commit}`);
    },
  });

  console.log(`[install:local] ${reused ? 'reused' : 'installed'} ${target}`);
  console.log(`[install:local] current -> ${path.basename(target)}${previous ? ` (was ${previous})` : ''}`);
  console.log('[install:local] restart the tunnel-client daemon to load it');
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[install:local] FAIL', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
