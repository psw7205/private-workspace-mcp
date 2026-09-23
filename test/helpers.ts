import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkspaceError, type ErrorCode } from '../src/errors/errors.js';

export interface Fixture {
  /** Workspace root as created by mkdtemp. On macOS this sits behind the `/var -> /private/var` symlink. */
  root: string;
  /** Canonical workspace root, as the server uses it after startup. */
  realRoot: string;
  /** Canonical directory next to the workspace that must never be reachable. */
  outside: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds:
 *
 *   <base>/workspace/
 *     README.md, src/index.ts, .env, .git/config
 *     link-inside-file -> src/index.ts      link-inside-dir -> src
 *     link-outside-file -> outside/private.txt
 *     link-outside-dir -> outside           link-parent -> ..
 *     link-to-env -> .env                   link-dangling -> outside/missing
 *   <base>/outside/private.txt
 */
export async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'pwmcp-'));
  const root = path.join(base, 'workspace');
  const outsideRaw = path.join(base, 'outside');

  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'));
  await mkdir(outsideRaw);

  await writeFile(path.join(root, 'README.md'), '# readme\n');
  await writeFile(path.join(root, 'src/index.ts'), 'export {};\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await writeFile(path.join(root, '.git/config'), '[core]\n');
  await writeFile(path.join(outsideRaw, 'private.txt'), 'outside secret\n');

  await symlink('src/index.ts', path.join(root, 'link-inside-file'));
  // Directory links need an explicit type on Windows; POSIX ignores it.
  await symlink('src', path.join(root, 'link-inside-dir'), 'dir');
  await symlink(path.join(outsideRaw, 'private.txt'), path.join(root, 'link-outside-file'));
  await symlink(outsideRaw, path.join(root, 'link-outside-dir'), 'dir');
  await symlink('..', path.join(root, 'link-parent'), 'dir');
  await symlink('.env', path.join(root, 'link-to-env'));
  await symlink(path.join(outsideRaw, 'missing'), path.join(root, 'link-dangling'));

  return {
    root,
    realRoot: await realpath(root),
    outside: await realpath(outsideRaw),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export async function expectWorkspaceError(promise: Promise<unknown>, code: ErrorCode): Promise<WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof WorkspaceError)) {
      throw new Error(`expected WorkspaceError(${code}), got ${String(error)}`);
    }
    if (error.code !== code) {
      throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected WorkspaceError(${code}), but the call succeeded`);
}

export function expectNoHostPath(text: string, fixture: Fixture): void {
  for (const hostPath of [fixture.root, fixture.realRoot, fixture.outside]) {
    if (text.includes(hostPath)) {
      throw new Error(`host path leaked: ${text}`);
    }
  }
}
