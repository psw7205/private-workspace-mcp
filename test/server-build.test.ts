import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serverBuild } from '../scripts/bundle.js';
import { runGit } from './helpers.js';

describe('serverBuild', () => {
  let repo: string;
  let commit: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'pwmcp-build-'));
    await writeFile(path.join(repo, 'README.md'), '# readme\n');
    runGit(repo, ['init', '-q']);
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-q', '-m', 'initial']);
    commit = runGit(repo, ['rev-parse', '--short=12', 'HEAD']).trim();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is the 12-character commit of a clean checkout', () => {
    expect(commit).toMatch(/^[0-9a-f]{12}$/);
    expect(serverBuild(repo)).toBe(commit);
  });

  it('ignores untracked files, as `pnpm install:local` does', async () => {
    await writeFile(path.join(repo, 'scratch.txt'), 'scratch\n');
    expect(serverBuild(repo)).toBe(commit);
  });

  it('marks uncommitted changes to tracked files as dirty', async () => {
    await writeFile(path.join(repo, 'README.md'), '# changed\n');
    expect(serverBuild(repo)).toBe(`${commit}-dirty`);
    runGit(repo, ['add', 'README.md']);
    expect(serverBuild(repo)).toBe(`${commit}-dirty`);
  });

  it('fails outside a Git checkout instead of reporting a build', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'pwmcp-nogit-'));
    try {
      expect(() => serverBuild(plain)).toThrow(/not a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
