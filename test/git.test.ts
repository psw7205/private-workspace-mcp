import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceError } from '../src/errors/errors.js';
import { denyExcludes, gitDiff, gitLog, gitShow, gitStatus } from '../src/git/operations.js';
import { checkConfig, isOwnedBy, parseConfigList, type GitContext } from '../src/git/repository.js';
import { assertGitSucceeded, buildGitEnv, detectGit, findGit, gitGlobalArgs, GitRunner, hardenedPath } from '../src/git/runner.js';
import { PathGuard } from '../src/filesystem/path-guard.js';
import { createDenyMatcher, DEFAULT_DENY_PATTERNS } from '../src/policy/deny-list.js';
import { runTool } from '../src/tools/run-tool.js';
import { createFixture, expectNoHostPath, expectWorkspaceError, initRepository, runGit, type Fixture } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const windowsOnly = process.platform === 'win32' ? it : it.skip;
const HARDENED_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_NO_LAZY_FETCH',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OPTIONAL_LOCKS',
  'GIT_PAGER',
  'GIT_TERMINAL_PROMPT',
  'LC_ALL',
  'PATH',
];

let gitPath: string;
beforeAll(async () => {
  gitPath = (await detectGit([])).path;
});

const signal = () => AbortSignal.timeout(15_000);

function contextFor(fixture: Fixture, overrides: Partial<GitContext> = {}): GitContext {
  const denyPatterns = overrides.denyPatterns ?? [...DEFAULT_DENY_PATTERNS];
  const roots = overrides.roots ?? [fixture.realRoot];
  const root = overrides.root ?? fixture.realRoot;
  return {
    runner: new GitRunner({ gitPath, roots }),
    root,
    roots,
    guard: new PathGuard(root, createDenyMatcher(denyPatterns)),
    isDenied: createDenyMatcher(denyPatterns),
    denyPatterns,
    maxBytes: 1 << 20,
    ...overrides,
  };
}

/** Every tool entry point, each with a fresh signal. */
function allCalls(ctx: GitContext): Array<[string, () => Promise<unknown>]> {
  return [
    ['git_status', () => gitStatus(ctx, signal())],
    ['git_diff worktree', () => gitDiff(ctx, {}, signal())],
    ['git_diff staged', () => gitDiff(ctx, { staged: true }, signal())],
    ['git_diff revs', () => gitDiff(ctx, { base: 'HEAD~1', head: 'HEAD' }, signal())],
    ['git_log', () => gitLog(ctx, {}, signal())],
    ['git_show', () => gitShow(ctx, { rev: 'HEAD' }, signal())],
  ];
}

/** Forward slashes: git runs config commands through sh, also on Windows (Git for Windows). */
const slash = (value: string) => value.split(path.sep).join('/');

/** A config command that records `name` in `marker` (outside the workspace) and passes stdin through. */
async function markerCommand(fixture: Fixture): Promise<{ marker: string; command: (name: string) => string }> {
  const script = path.join(fixture.outside, 'marker.cjs');
  const marker = path.join(fixture.outside, 'marker.log');
  await writeFile(
    script,
    "require('node:fs').appendFileSync(process.argv[2], process.argv[3] + '\\n');\nprocess.stdin.on('error', () => {});\nprocess.stdin.pipe(process.stdout);\n",
  );
  return { marker, command: (name) => `"${slash(process.execPath)}" "${slash(script)}" "${slash(marker)}" ${name}` };
}

async function commitAll(fixture: Fixture, message: string): Promise<string> {
  runGit(fixture.root, ['add', '-A']);
  runGit(fixture.root, ['commit', '-q', '-m', message]);
  return runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
}

describe('git runner environment (ADR-004 §2.2, §2.3)', () => {
  it('builds the child environment from nothing, keeping only a hardened PATH', () => {
    const root = path.resolve('/srv/ws');
    const env = buildGitEnv(
      {
        PATH: ['/usr/bin', 'relative/bin', '', path.join(root, 'bin'), '/opt/tools'].join(':'),
        CONTROL_PLANE_API_KEY: 'sk-secret',
        OPENAI_API_KEY: 'sk-secret',
        GIT_DIR: '/elsewhere/.git',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
        GIT_CONFIG_COUNT: '1',
        HOME: '/srv/user',
        XDG_CONFIG_HOME: '/srv/user/.config',
        SSH_AUTH_SOCK: '/tmp/agent',
      },
      [root],
      'linux',
    );
    expect(Object.keys(env).sort()).toEqual(HARDENED_KEYS);
    expect(env).toMatchObject({
      PATH: '/usr/bin:/opt/tools',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
    });
    expect(JSON.stringify(env)).not.toContain('sk-secret');
  });

  it('keeps SystemRoot and windir on Windows and reads Path case-insensitively', () => {
    const env = buildGitEnv(
      { Path: 'C:\\Windows\\system32;.\\bin;C:\\Program Files\\Git\\cmd', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' },
      [],
      'win32',
    );
    expect(Object.keys(env).sort()).toEqual([...HARDENED_KEYS, 'SystemRoot', 'windir'].sort());
    expect(env.PATH).toBe('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd');
  });

  describe('with a fixture', () => {
    let fixture: Fixture;
    beforeEach(async () => {
      fixture = await createFixture();
    });
    afterEach(async () => {
      await fixture.cleanup();
    });

    it('drops PATH entries inside a workspace, also through a symlink', async () => {
      await symlink(fixture.realRoot, path.join(fixture.outside, 'alias'), 'dir');
      const value = [path.join(fixture.root, 'bin'), path.join(fixture.outside, 'alias', 'bin'), fixture.outside].join(path.delimiter);
      expect(hardenedPath({ PATH: value }, [fixture.realRoot])).toBe(fixture.outside);
    });

    posixOnly('never picks a git executable from inside a workspace root', async () => {
      const bin = path.join(fixture.realRoot, 'bin');
      await mkdir(bin);
      await writeFile(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n');
      await chmod(path.join(bin, 'git'), 0o755);
      const found = await findGit([bin, path.dirname(gitPath)].join(':'), [fixture.realRoot]);
      expect(found).toBe(gitPath);
      expect(await findGit(bin, [fixture.realRoot])).toBeUndefined();
    });

    it('fails startup detection when no git is reachable', async () => {
      await expect(detectGit([fixture.realRoot], { PATH: fixture.outside })).rejects.toThrow(/requires git on PATH/);
    });

    posixOnly('passes nothing else from the server environment to git', async () => {
      const dump = path.join(fixture.outside, 'env.txt');
      const fake = path.join(fixture.outside, 'fake-git');
      await writeFile(fake, `#!/bin/sh\nenv > '${dump}'\n`);
      await chmod(fake, 0o755);
      const runner = new GitRunner({
        gitPath: fake,
        roots: [fixture.realRoot],
        env: { PATH: '/usr/bin:/bin', CONTROL_PLANE_API_KEY: 'sk-live-secret', HOME: '/srv/x', GIT_DIR: fixture.outside, SSH_AUTH_SOCK: '/tmp/s' },
      });
      await runner.run(fixture.realRoot, ['status'], { signal: signal(), maxBytes: 1024 });
      const keys = (await readFile(dump, 'utf8'))
        .split('\n')
        .map((line) => line.split('=')[0])
        .filter((key): key is string => key !== undefined && key !== '' && !['PWD', 'SHLVL', 'OLDPWD', '_'].includes(key));
      expect(keys.sort()).toEqual([...HARDENED_KEYS, 'GIT_DIR', 'GIT_WORK_TREE'].sort());
      const dumped = await readFile(dump, 'utf8');
      expect(dumped).not.toContain('sk-live-secret');
      expect(dumped).toContain(`GIT_DIR=${path.join(fixture.realRoot, '.git')}\n`);
    });
  });
});

describe('config-driven programs never run (ADR-004 §2.3)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    await initRepository(fixture);
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('ignores filters (also via HEAD attributes), fsmonitor, textconv, external diff, pager, gpg, and hooks in every tool', async () => {
    const { marker, command } = await markerCommand(fixture);
    await writeFile(path.join(fixture.root, '.gitattributes'), '*.txt filter=evil diff=evil\n*.md filter=lfs diff=evil\n');
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    await commitAll(fixture, 'attributes');
    await writeFile(path.join(fixture.root, 'a.txt'), 'two\n');
    await writeFile(path.join(fixture.root, 'b.txt'), 'new\n');
    runGit(fixture.root, ['add', 'b.txt']);
    await writeFile(path.join(fixture.root, 'a.txt'), 'three\n');

    for (const [key, name] of [
      ['filter.evil.clean', 'clean'],
      ['filter.evil.smudge', 'smudge'],
      ['filter.evil.process', 'process'],
      ['filter.lfs.clean', 'lfs-clean'],
      ['filter.lfs.process', 'lfs-process'],
      ['filter.other.clean', 'other-clean'],
      ['diff.evil.textconv', 'textconv'],
      ['diff.evil.command', 'diff-command'],
      ['diff.external', 'external'],
      ['core.fsmonitor', 'fsmonitor'],
      ['core.pager', 'pager'],
      ['pager.log', 'pager-log'],
      ['gpg.program', 'gpg'],
    ] as const) {
      runGit(fixture.root, ['config', key, command(name)]);
    }
    runGit(fixture.root, ['config', 'filter.evil.required', 'true']);
    runGit(fixture.root, ['config', 'log.showSignature', 'true']);
    // Worktree attributes that HEAD does not have; --attr-source=HEAD ignores them.
    await writeFile(path.join(fixture.root, '.gitattributes'), '*.txt filter=other diff=evil\n*.md filter=lfs diff=evil\n');
    if (process.platform !== 'win32') {
      const hook = path.join(fixture.root, '.git', 'hooks', 'post-index-change');
      await mkdir(path.dirname(hook), { recursive: true });
      await writeFile(hook, `#!/bin/sh\necho hook >> '${marker}'\n`);
      await chmod(hook, 0o755);
    }
    // A stat-only change makes status and diff-files re-read the file through the clean filter.
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(fixture.root, 'README.md'), future, future);
    // Positive control: the marker command does run under an unhardened git on this platform,
    // so the absence asserted below is not vacuous (e.g. a quoting failure on Windows).
    await writeFile(path.join(fixture.root, '.gitattributes'), 'probe.bin filter=probe\n', { flag: 'a' });
    runGit(fixture.root, ['config', 'filter.probe.clean', command('probe')]);
    await writeFile(path.join(fixture.root, 'probe.bin'), 'probe\n');
    runGit(fixture.root, ['add', 'probe.bin']);
    expect(await readFile(marker, 'utf8')).toContain('probe');
    await rm(marker, { force: true });

    const ctx = contextFor(fixture);
    for (const [label, call] of allCalls(ctx)) {
      await expect(call(), label).resolves.toBeDefined();
    }
    const show = await gitShow(ctx, { rev: 'HEAD' }, signal());
    expect(show.result.patch).toContain('+one');
    const diff = await gitDiff(ctx, {}, signal());
    expect(diff.result.patch).toContain('+three');
    expect(existsSync(marker), existsSync(marker) ? await readFile(marker, 'utf8') : '').toBe(false);
  });

  it('reads attributes from HEAD, not from the worktree or core.attributesFile', async () => {
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    await commitAll(fixture, 'a');
    await writeFile(path.join(fixture.root, 'a.txt'), 'two\n');
    // Either source would turn the patch into "Binary files ... differ".
    await writeFile(path.join(fixture.root, '.gitattributes'), 'a.txt -diff\n');
    const attributes = path.join(fixture.outside, 'attributes');
    await writeFile(attributes, 'README.md -diff\n');
    runGit(fixture.root, ['config', 'core.attributesFile', attributes]);
    await writeFile(path.join(fixture.root, 'README.md'), '# changed\n');

    const { result } = await gitDiff(contextFor(fixture), {}, signal());
    expect(result.patch).toContain('+two');
    expect(result.patch).toContain('+# changed');
    expect(result.patch).not.toContain('Binary files');
  });

  it('works before the first commit without reading worktree attributes or running filters', async () => {
    const { marker, command } = await markerCommand(fixture);
    await rm(path.join(fixture.root, '.git'), { recursive: true, force: true });
    runGit(fixture.root, ['init', '-q']);
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    runGit(fixture.root, ['add', 'a.txt']);
    runGit(fixture.root, ['config', 'filter.evil.clean', command('clean')]);
    runGit(fixture.root, ['config', 'filter.evil.process', command('process')]);
    // Only the worktree has attributes; with no HEAD they must still be ignored.
    await writeFile(path.join(fixture.root, '.gitattributes'), 'a.txt -diff filter=evil\n*.md filter=evil\n');
    await writeFile(path.join(fixture.root, 'a.txt'), 'two\n');
    const ctx = contextFor(fixture);

    const status = await gitStatus(ctx, signal());
    expect(status.result).toMatchObject({ branch: 'main', oid: null, upstream: null, upstream_differs: null });
    expect(status.result.entries).toContainEqual({ path: 'a.txt', index: 'A', worktree: 'M' });
    const staged = await gitDiff(ctx, { staged: true }, signal());
    expect(staged.result.files).toEqual([{ path: 'a.txt', status: 'A' }]);
    expect(staged.result.patch).toContain('+one');
    const worktree = await gitDiff(ctx, {}, signal());
    expect(worktree.result.patch).toContain('+two');
    expect(worktree.result.patch).not.toContain('Binary files');
    await expectWorkspaceError(gitLog(ctx, {}, signal()), 'INVALID_REVISION');
    expect(existsSync(marker)).toBe(false);
  });

  it('never rewrites .git/index, even for stat-only changes', async () => {
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    await commitAll(fixture, 'a');
    await writeFile(path.join(fixture.root, 'a.txt'), 'two\n');
    await writeFile(path.join(fixture.root, 'staged.txt'), 'staged\n');
    runGit(fixture.root, ['add', 'staged.txt']);
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(fixture.root, 'README.md'), future, future);

    const index = path.join(fixture.root, '.git', 'index');
    const before = { bytes: await readFile(index), mtime: (await stat(index)).mtimeMs };
    for (const [label, call] of allCalls(contextFor(fixture))) {
      await expect(call(), label).resolves.toBeDefined();
    }
    expect(await readFile(index)).toEqual(before.bytes);
    expect((await stat(index)).mtimeMs).toBe(before.mtime);
  });
});

describe('repository config check (ADR-004 §2.4.1)', () => {
  let fixture: Fixture;
  let other: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    other = await createFixture();
    await initRepository(fixture);
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    await commitAll(fixture, 'a');
    await writeFile(path.join(fixture.root, '.gitattributes'), '* filter=lfs\n');
    await commitAll(fixture, 'attributes');
  });
  afterEach(async () => {
    await fixture.cleanup();
    await other.cleanup();
  });

  const unsafeCases: Array<[string, (fixture: Fixture, other: Fixture, command: (name: string) => string) => Promise<void>]> = [
    [
      'include.path=../.gitconfig with a filter in it',
      async (f, _o, command) => {
        await writeFile(path.join(f.root, '.gitconfig'), `[filter "lfs"]\n\tclean = ${command('included-clean')}\n\tprocess = ${command('included-process')}\n`);
        runGit(f.root, ['config', 'include.path', '../.gitconfig']);
      },
    ],
    ['include.path=../.gitconfig without the file yet', async (f) => void runGit(f.root, ['config', 'include.path', '../.gitconfig'])],
    ['includeIf.*.path into the worktree', async (f) => void runGit(f.root, ['config', 'includeIf.onbranch:main.path', '../conf/extra'])],
    ['include.path into another workspace', async (f, o) => void runGit(f.root, ['config', 'include.path', path.join(o.realRoot, 'cfg')])],
    ['core.attributesFile in the worktree', async (f) => void runGit(f.root, ['config', 'core.attributesFile', path.join(f.realRoot, 'attrs')])],
    // Relative to .git/config this is inside .git, relative to the root it is not: both readings count (M55).
    ['relative core.excludesFile', async (f) => void runGit(f.root, ['config', 'core.excludesFile', 'excludes'])],
    ['mailmap.file in the worktree', async (f) => void runGit(f.root, ['config', 'mailmap.file', '../.mailmap'])],
    ['core.hooksPath in the worktree', async (f) => void runGit(f.root, ['config', 'core.hooksPath', path.join(f.realRoot, 'hooks')])],
    [
      'a config hook',
      async (f, _o, command) => {
        runGit(f.root, ['config', 'hook.audit.command', command('config-hook')]);
        runGit(f.root, ['config', 'hook.audit.event', 'post-index-change']);
      },
    ],
    ['a filter driver name -c cannot express', async (f, _o, command) => void runGit(f.root, ['config', 'filter.a=b.clean', command('eq-clean')])],
    [
      // Lexically inside the workspace even though the link resolves outside: the model can retarget it.
      'include.path through a workspace symlink that points outside',
      async (f, _o, command) => {
        await writeFile(path.join(f.outside, 'linked.cfg'), `[filter "lfs"]\n\tclean = ${command('linked-clean')}\n`);
        await symlink(f.outside, path.join(f.root, 'out-link'), 'dir');
        runGit(f.root, ['config', 'include.path', '../out-link/linked.cfg']);
      },
    ],
  ];

  it('audits only the class of a rejected key, never its subsection', async () => {
    const includeIf = `includeIf.hasconfig:remote.*.url:https://user:tok3n@example.com/${slash(fixture.realRoot)}/**.path`;
    runGit(fixture.root, ['config', includeIf, '../conf/extra']);
    const error = await expectWorkspaceError(gitStatus(contextFor(fixture), signal()), 'UNSAFE_GIT_CONFIG');
    expect(error.detail).toBe('includeif.*.path');

    runGit(fixture.root, ['config', '--unset', includeIf]);
    runGit(fixture.root, ['config', 'hook.secret-name.command', 'true']);
    expect((await expectWorkspaceError(gitStatus(contextFor(fixture), signal()), 'UNSAFE_GIT_CONFIG')).detail).toBe('hook.*.command');

    runGit(fixture.root, ['config', '--unset', 'hook.secret-name.command']);
    runGit(fixture.root, ['config', 'include.path', '../.gitconfig']);
    expect((await expectWorkspaceError(gitStatus(contextFor(fixture), signal()), 'UNSAFE_GIT_CONFIG')).detail).toBe('include.path');
  });

  it.each(unsafeCases)('rejects %s with UNSAFE_GIT_CONFIG in every tool and runs nothing', async (_label, setup) => {
    const { marker, command } = await markerCommand(fixture);
    await setup(fixture, other, command);
    const ctx = contextFor(fixture, { roots: [fixture.realRoot, other.realRoot] });
    for (const [label, call] of allCalls(ctx)) {
      const error = await expectWorkspaceError(call(), 'UNSAFE_GIT_CONFIG');
      expectNoHostPath(error.message, fixture);
      expectNoHostPath(error.message, other);
      expect(error.message, label).not.toMatch(/include\.|hook\.|filter\.|core\.|mailmap\./i);
      expect(error.detail, label).toBeDefined();
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed on an include.path starting with ~: git cannot expand it without HOME, so rev-parse already fails (M56)', async () => {
    const { marker } = await markerCommand(fixture);
    runGit(fixture.root, ['config', 'include.path', '~/.gitconfig']);
    for (const [label, call] of allCalls(contextFor(fixture))) {
      // Git for Windows expands `~` without HOME, so there the config check itself rejects it.
      await expectWorkspaceError(call(), process.platform === 'win32' ? 'UNSAFE_GIT_CONFIG' : 'NOT_A_REPOSITORY');
    }
    const gitConfig = path.join(fixture.realRoot, '.git', 'config');
    const entries = parseConfigList(Buffer.from(`local\0file:${gitConfig}\0include.path\n~/.gitconfig\0`));
    await expectWorkspaceError(checkConfig(entries, fixture.realRoot, [fixture.realRoot]), 'UNSAFE_GIT_CONFIG');
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts includes and path values inside .git or outside every workspace', async () => {
    await writeFile(path.join(fixture.root, '.git', 'extra'), '[core]\n\tabbrev = 12\n');
    await writeFile(path.join(fixture.outside, 'cfg'), '[core]\n\tabbrev = 10\n');
    runGit(fixture.root, ['config', 'include.path', 'extra']);
    runGit(fixture.root, ['config', '--add', 'include.path', path.join(fixture.outside, 'cfg')]);
    runGit(fixture.root, ['config', 'core.excludesFile', path.join(fixture.outside, 'excludes')]);
    const ctx = contextFor(fixture);
    for (const [label, call] of allCalls(ctx)) await expect(call(), label).resolves.toBeDefined();
  });

  it('parses valueless keys and neutralizes every filter driver it finds', async () => {
    const entries = parseConfigList(
      Buffer.from(
        `local\0file:${path.join(fixture.realRoot, '.git', 'config')}\0core.flag\0` +
          `local\0file:${path.join(fixture.realRoot, '.git', 'config')}\0filter.My.Drv.clean\ncat\0` +
          'command\0command line:\0core.hookspath\n/dev/null\0',
      ),
    );
    expect(entries.map(({ key, value }) => [key, value])).toEqual([
      ['core.flag', undefined],
      ['filter.My.Drv.clean', 'cat'],
      ['core.hookspath', '/dev/null'],
    ]);
    expect(await checkConfig(entries, fixture.realRoot, [fixture.realRoot])).toEqual([
      '-c',
      'filter.My.Drv.clean=',
      '-c',
      'filter.My.Drv.smudge=',
      '-c',
      'filter.My.Drv.process=',
      '-c',
      'filter.My.Drv.required=false',
    ]);
  });
});

describe('repository boundary (ADR-004 §2.4)', () => {
  let fixture: Fixture;
  let other: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    other = await createFixture();
    await initRepository(other);
  });
  afterEach(async () => {
    await fixture.cleanup();
    await other.cleanup();
  });

  const expectNotARepository = async (ctx: GitContext) => {
    for (const [, call] of allCalls(ctx)) {
      const error = await expectWorkspaceError(call(), 'NOT_A_REPOSITORY');
      expectNoHostPath(error.message, fixture);
      expectNoHostPath(error.message, other);
    }
  };

  it('rejects a .git directory that is not a repository', async () => {
    await expectNotARepository(contextFor(fixture));
  });

  it('rejects a gitfile', async () => {
    await rm(path.join(fixture.root, '.git'), { recursive: true });
    await writeFile(path.join(fixture.root, '.git'), `gitdir: ${path.join(other.realRoot, '.git')}\n`);
    await expectNotARepository(contextFor(fixture));
  });

  it('rejects a symlinked .git', async () => {
    await rm(path.join(fixture.root, '.git'), { recursive: true });
    await symlink(path.join(other.realRoot, '.git'), path.join(fixture.root, '.git'), 'dir');
    await expectNotARepository(contextFor(fixture));
  });

  it('rejects a workspace that is a subdirectory of a repository', async () => {
    await expectNotARepository(contextFor(other, { root: path.join(other.realRoot, 'src') }));
  });

  it('rejects a linked worktree', async () => {
    const worktree = path.join(fixture.outside, 'linked');
    runGit(other.root, ['worktree', 'add', '-q', worktree]);
    await expectNotARepository(contextFor(other, { root: await realpath(worktree), roots: [await realpath(worktree)] }));
  });

  it('rejects a submodule checkout', async () => {
    runGit(other.root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', slash(await sourceRepo(fixture)), 'sub']);
    const sub = path.join(other.realRoot, 'sub');
    await expectNotARepository(contextFor(other, { root: sub, roots: [sub] }));
  });

  it('rejects a .git whose commondir points elsewhere', async () => {
    await initRepository(fixture);
    await writeFile(path.join(fixture.root, '.git', 'commondir'), `${path.join(other.realRoot, '.git')}\n`);
    await expectNotARepository(contextFor(fixture));
  });

  it('requires the .git owner to be the server uid on POSIX', () => {
    expect(isOwnedBy(501, 501)).toBe(true);
    expect(isOwnedBy(0, 501)).toBe(false);
  });

  /** A separate repository to add as a submodule. */
  async function sourceRepo(f: Fixture): Promise<string> {
    const source = path.join(f.outside, 'source');
    await mkdir(source);
    runGit(source, ['init', '-q']);
    await writeFile(path.join(source, 'x.txt'), 'x\n');
    runGit(source, ['add', '-A']);
    runGit(source, ['commit', '-q', '-m', 'x']);
    return source;
  }
});

describe('revisions (ADR-004 §2.5)', () => {
  let fixture: Fixture;
  let first: string;
  beforeEach(async () => {
    fixture = await createFixture();
    await initRepository(fixture);
    first = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(fixture.root, 'a.txt'), 'one\n');
    await commitAll(fixture, 'second');
    runGit(fixture.root, ['tag', 'v1']);
    runGit(fixture.root, ['branch', 'feature']);
    runGit(fixture.root, ['notes', 'add', '-m', 'a note', 'HEAD']);
    // stash^3 would be this untracked secret.
    await writeFile(path.join(fixture.root, 'untracked-secret.txt'), 'STASHED-SECRET\n');
    await writeFile(path.join(fixture.root, 'a.txt'), 'two\n');
    runGit(fixture.root, ['stash', 'push', '-q', '-u']);
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  const rejected = [
    'HEAD:.env',
    ':/initial',
    '--output=OUT',
    '-n1',
    'stash',
    'stash^3',
    'stash@{0}',
    'refs/stash',
    'refs/notes/commits',
    'notes/commits',
    'HEAD..main',
    'HEAD...main',
    'main@{1}',
    'HEAD HEAD',
    'HEAD~',
    '@',
    'main^{tree}',
    'ORIG_HEAD',
    'nope',
    'deadbeef',
    '../main',
  ];

  it.each(rejected)('rejects %j with INVALID_REVISION in git_show, git_log, and git_diff', async (rev) => {
    const input = rev.replace('OUT', path.join(fixture.outside, 'out.txt'));
    const ctx = contextFor(fixture);
    for (const call of [
      () => gitShow(ctx, { rev: input }, signal()),
      () => gitLog(ctx, { rev: input }, signal()),
      () => gitDiff(ctx, { base: input }, signal()),
      () => gitDiff(ctx, { base: 'HEAD', head: input }, signal()),
    ]) {
      const error = await expectWorkspaceError(call(), 'INVALID_REVISION');
      expect(error.message).not.toContain(input);
      expectNoHostPath(error.message, fixture);
    }
    expect(existsSync(path.join(fixture.outside, 'out.txt'))).toBe(false);
  });

  it('accepts HEAD, ancestry suffixes, branches, tags, and commit ids', async () => {
    const second = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    const ctx = contextFor(fixture);
    for (const [rev, oid] of [
      ['HEAD', second],
      ['HEAD~1', first],
      ['HEAD^', first],
      ['main^1', first],
      ['main', second],
      ['refs/heads/main', second],
      ['feature', second],
      ['v1', second],
      [second, second],
      [first.slice(0, 7), first],
    ] as const) {
      const { result } = await gitShow(ctx, { rev }, signal());
      expect(result.commit.oid, rev).toBe(oid);
    }
    const show = await gitShow(ctx, { rev: 'HEAD' }, signal());
    expect(JSON.stringify(show)).not.toContain('STASHED-SECRET');
  });

  it('rejects inconsistent git_diff inputs', async () => {
    const ctx = contextFor(fixture);
    await expectWorkspaceError(gitDiff(ctx, { head: 'HEAD' }, signal()), 'INVALID_REVISION');
    await expectWorkspaceError(gitDiff(ctx, { base: 'HEAD', staged: true }, signal()), 'INVALID_REVISION');
  });

  it('reports a detached HEAD and still logs from it', async () => {
    runGit(fixture.root, ['switch', '-q', '--detach', first]);
    const ctx = contextFor(fixture);
    const status = await gitStatus(ctx, signal());
    expect(status.result).toMatchObject({ branch: null, oid: first, upstream: null, upstream_differs: null });
    const log = await gitLog(ctx, {}, signal());
    expect(log.result.commits.map((commit) => commit.oid)).toEqual([first]);
    expect(log.result.commits[0]).toMatchObject({ parents: [], message: 'initial', author: { name: 'Test', email: 'test@example.com' } });
  });

  it('reports whether the branch differs from its upstream without counting', async () => {
    runGit(fixture.root, ['branch', '-q', '--set-upstream-to=feature', 'main']);
    const ctx = contextFor(fixture);
    expect((await gitStatus(ctx, signal())).result).toMatchObject({ branch: 'main', upstream: 'feature', upstream_differs: false });
    runGit(fixture.root, ['commit', '-q', '--allow-empty', '-m', 'ahead']);
    expect((await gitStatus(ctx, signal())).result).toMatchObject({ upstream: 'feature', upstream_differs: true });
  });
});

describe('deny filtering (ADR-004 §2.6)', () => {
  let fixture: Fixture;
  let added: string;
  let removed: string;
  const extra = ['private*', 'x[1]'];
  const secrets: Record<string, string> = {
    'secret.yaml': 'TOPSECRET-1\n',
    'config/.ENV': 'TOPSECRET-2\n',
    'Secrets/token.txt': 'TOPSECRET-3\n',
    'a/.ssh/config': 'TOPSECRET-4\n',
    'private-notes.md': 'TOPSECRET-5\n',
    'x[1]': 'TOPSECRET-6\n',
    'deep/Credentials.json': 'TOPSECRET-7\n',
  };
  const secretPaths = Object.keys(secrets);

  beforeEach(async () => {
    fixture = await createFixture();
    await writeFile(path.join(fixture.root, '.env'), 'TOPSECRET-0\n');
    await initRepository(fixture);
    for (const [file, content] of Object.entries(secrets)) {
      await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true });
      await writeFile(path.join(fixture.root, file), content);
    }
    await writeFile(path.join(fixture.root, 'x1'), 'visible-x1\n');
    await writeFile(path.join(fixture.root, 'keep.txt'), 'visible-1\n');
    added = await commitAll(fixture, 'add hidden');
    for (const file of secretPaths) await rm(path.join(fixture.root, file));
    await writeFile(path.join(fixture.root, 'keep.txt'), 'visible-2\n');
    removed = await commitAll(fixture, 'remove hidden');
    // Worktree: a denied tracked file changed, denied untracked files, a denied staged file.
    await writeFile(path.join(fixture.root, '.env'), 'TOPSECRET-8\n');
    await writeFile(path.join(fixture.root, '.env.local'), 'TOPSECRET-9\n');
    await writeFile(path.join(fixture.root, 'SECRET.md'), 'TOPSECRET-10\n');
    await writeFile(path.join(fixture.root, 'secret.yaml'), 'TOPSECRET-11\n');
    runGit(fixture.root, ['add', 'secret.yaml']);
    await writeFile(path.join(fixture.root, 'keep.txt'), 'visible-3\n');
    await writeFile(path.join(fixture.root, 'staged.txt'), 'visible-4\n');
    runGit(fixture.root, ['add', 'staged.txt']);
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  const layers: Array<[string, (f: Fixture) => GitContext]> = [
    ['both layers', (f) => contextFor(f, { denyPatterns: [...DEFAULT_DENY_PATTERNS, ...extra] })],
    // Each layer alone must hold (layer 1: pathspec excludes, layer 2: in-process filter).
    ['static excludes only', (f) => ({ ...contextFor(f, { denyPatterns: [...DEFAULT_DENY_PATTERNS, ...extra] }), isDenied: () => false })],
    ['in-process filter only', (f) => ({ ...contextFor(f, { denyPatterns: [] }), isDenied: createDenyMatcher([...DEFAULT_DENY_PATTERNS, ...extra]) })],
  ];

  it.each(layers)('keeps denied files out of status, diff, and show (%s)', async (_label, make) => {
    const ctx = make(fixture);
    const outputs = {
      status: await gitStatus(ctx, signal()),
      worktree: await gitDiff(ctx, {}, signal()),
      staged: await gitDiff(ctx, { staged: true }, signal()),
      revs: await gitDiff(ctx, { base: `${added}~1`, head: removed }, signal()),
      added: await gitShow(ctx, { rev: added }, signal()),
      removed: await gitShow(ctx, { rev: removed }, signal()),
    };
    const text = JSON.stringify(outputs);
    expect(text).not.toMatch(/TOPSECRET/);
    expect(text).not.toMatch(/\.env|secret|\.ssh|private-notes|x\[1\]|credentials/i);
    expectNoHostPath(text, fixture);

    expect(outputs.status.result.entries.map((entry) => entry.path).sort()).toEqual(['keep.txt', 'staged.txt']);
    expect(outputs.worktree.result.files).toEqual([{ path: 'keep.txt', status: 'M' }]);
    expect(outputs.staged.result.files).toEqual([{ path: 'staged.txt', status: 'A' }]);
    expect(outputs.added.result.files.map((file) => file.path).sort()).toEqual(['keep.txt', 'x1']);
    expect(outputs.added.result.commit.message).toBe('add hidden');
    expect(outputs.added.result.patch).toContain('+visible-x1');
    expect(outputs.removed.result.files).toEqual([{ path: 'keep.txt', status: 'M' }]);
  });

  // Windows forbids control characters in file names.
  posixOnly('keeps denied names with line terminators out in each layer alone (M64)', async () => {
    await writeFile(path.join(fixture.root, 'key\nfile.pem'), 'TOPSECRET-NL-1\n');
    await writeFile(path.join(fixture.root, 'visible\nname.txt'), 'visible-nl\n');
    const committed = await commitAll(fixture, 'newline names');
    await writeFile(path.join(fixture.root, 'id_rsa\nbackup'), 'TOPSECRET-NL-2\n');
    for (const [label, make] of layers) {
      const ctx = make(fixture);
      const show = await gitShow(ctx, { rev: committed }, signal());
      const status = await gitStatus(ctx, signal());
      expect(JSON.stringify([show, status]), label).not.toMatch(/TOPSECRET|\.pem|id_rsa/);
      expect(show.result.files.map((file) => file.path), label).toContain('visible\nname.txt');
    }
  });

  it('shows a commit that only touched denied files with its metadata and no files', async () => {
    await rm(path.join(fixture.root, '.env'));
    runGit(fixture.root, ['add', '.env']);
    runGit(fixture.root, ['commit', '-q', '-m', 'drop env', '--', '.env']);
    const { result } = await gitShow(contextFor(fixture), { rev: 'HEAD' }, signal());
    expect(result).toMatchObject({ commit: { message: 'drop env' }, files: [], patch: '', truncated: false });
  });

  it('rejects denied path arguments, including case variants and directory segments', async () => {
    const ctx = contextFor(fixture, { denyPatterns: [...DEFAULT_DENY_PATTERNS, ...extra] });
    for (const target of ['.env', 'config/.ENV', 'Secrets/token.txt', 'a/.ssh', 'private-notes.md', '.git/config']) {
      await expectWorkspaceError(gitLog(ctx, { path: target }, signal()), 'PATH_BLOCKED');
      await expectWorkspaceError(gitDiff(ctx, { path: target }, signal()), 'PATH_BLOCKED');
    }
    await expectWorkspaceError(gitLog(ctx, { path: '../outside' }, signal()), 'PATH_OUTSIDE_WORKSPACE');
    await expectWorkspaceError(gitLog(ctx, { path: '/etc' }, signal()), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('applies the deny list and containment to the canonical form of path, too', async () => {
    await symlink('.git', path.join(fixture.root, 'alias'), 'dir');
    await symlink('secret.yaml', path.join(fixture.root, 'plain-name'));
    const ctx = contextFor(fixture);
    for (const target of ['alias', 'alias/config', 'alias/hooks/missing', 'plain-name']) {
      await expectWorkspaceError(gitLog(ctx, { path: target }, signal()), 'PATH_BLOCKED');
      await expectWorkspaceError(gitDiff(ctx, { path: target }, signal()), 'PATH_BLOCKED');
    }
    const outside = await expectWorkspaceError(gitLog(ctx, { path: 'link-outside-dir/private.txt' }, signal()), 'PATH_OUTSIDE_WORKSPACE');
    expectNoHostPath(outside.message, fixture);
    // Deleted and never-existing paths still work: only their existing prefix is resolved.
    expect((await gitLog(ctx, { path: 'gone/deeper/file.txt' }, signal())).result.commits).toEqual([]);
  });

  it('treats path as a literal pathspec that may name deleted files', async () => {
    const ctx = contextFor(fixture);
    
    const log = await gitLog(ctx, { path: 'keep.txt' }, signal());
    expect(log.result.commits.map((commit) => commit.message)).toEqual(['remove hidden', 'add hidden']);
    expect((await gitLog(ctx, { path: '[k]eep.txt' }, signal())).result.commits).toEqual([]);
    const deleted = await gitLog(ctx, { path: 'x1' }, signal());
    expect(deleted.result.commits).toHaveLength(1);
  });

  it('escapes glob characters of deny patterns', () => {
    expect(denyExcludes(['x[1]', 'a?b', '*.pem'])).toEqual([
      ':(exclude,icase,glob)**/x[[]1]',
      ':(exclude,icase,glob)**/x[[]1]/**',
      ':(exclude,icase,glob)**/a[?]b',
      ':(exclude,icase,glob)**/a[?]b/**',
      ':(exclude,icase,glob)**/*.pem',
      ':(exclude,icase,glob)**/*.pem/**',
    ]);
  });
});

describe('output cap (ADR-004 §2.7)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    await initRepository(fixture);
    for (let index = 0; index < 6; index++) {
      await writeFile(path.join(fixture.root, `file-${index}.txt`), `${'line\n'.repeat(40)}`);
    }
    await commitAll(fixture, 'six files');
    for (let index = 0; index < 12; index++) {
      runGit(fixture.root, ['commit', '-q', '--allow-empty', '-m', `commit ${index}\n\n${'body '.repeat(20)}`]);
    }
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('cuts a patch at the last complete file section', async () => {
    const full = await gitShow(contextFor(fixture), { rev: 'HEAD~12' }, signal());
    expect(full.truncated).toBe(false);
    const cut = await gitShow(contextFor(fixture, { maxBytes: 700 }), { rev: 'HEAD~12' }, signal());
    expect(cut.truncated).toBe(true);
    expect(cut.result.truncated).toBe(true);
    expect(cut.result.files).toHaveLength(6);
    expect(cut.result.patch.length).toBeGreaterThan(0);
    expect(full.result.patch.startsWith(cut.result.patch)).toBe(true);
    expect(full.result.patch.slice(cut.result.patch.length)).toMatch(/^diff --git /);
  });

  it('drops a commit cut in the middle of the log', async () => {
    const full = await gitLog(contextFor(fixture), {}, signal());
    const cut = await gitLog(contextFor(fixture, { maxBytes: 1000 }), {}, signal());
    expect(cut.truncated).toBe(true);
    expect(cut.result.commits.length).toBeGreaterThan(0);
    expect(cut.result.commits.length).toBeLessThan(full.result.commits.length);
    expect(cut.result.commits).toEqual(full.result.commits.slice(0, cut.result.commits.length));
  });

  it('returns no patch when the file listing itself was cut (M58)', async () => {
    for (let index = 0; index < 6; index++) await writeFile(path.join(fixture.root, `file-${index}.txt`), 'changed\n');
    const { result } = await gitDiff(contextFor(fixture, { maxBytes: 120 }), {}, signal());
    expect(result.truncated).toBe(true);
    expect(result.patch).toBe('');
    expect(result.files.length).toBeLessThan(6);
  });

  it('caps git_log max_count and default', async () => {
    expect((await gitLog(contextFor(fixture), {}, signal())).result.commits).toHaveLength(14);
    expect((await gitLog(contextFor(fixture), { max_count: 3 }, signal())).result.commits).toHaveLength(3);
  });
});

describe('process termination (ADR-004 §2.7, POSIX)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  /** A fake git that starts a sleeping grandchild in its group, records both pids, then runs `body`. */
  async function fakeGit(name: string, body: string): Promise<{ runner: GitRunner; pids: () => Promise<number[]> }> {
    const script = path.join(fixture.outside, name);
    const pidFile = path.join(fixture.outside, `${name}.pids`);
    await writeFile(script, `#!/bin/sh\nsleep 100 &\necho $! > '${pidFile}'\necho $$ >> '${pidFile}'\n${body}\n`);
    await chmod(script, 0o755);
    return {
      runner: new GitRunner({ gitPath: script, roots: [fixture.realRoot] }),
      pids: async () => {
        for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise((r) => setTimeout(r, 20));
        return (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
      },
    };
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const expectAllDead = async (pids: number[]) => {
    for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) await new Promise((r) => setTimeout(r, 20));
    expect(pids.filter(alive)).toEqual([]);
  };

  posixOnly('kills the whole process group when the tool times out', async () => {
    const { runner, pids } = await fakeGit('slow-git', 'wait');
    const controller = new AbortController();
    const run = runner.run(fixture.realRoot, ['status'], { signal: controller.signal, maxBytes: 1024 });
    const started = await pids();
    expect(started.every(alive)).toBe(true);
    controller.abort(new Error('timeout'));
    await expect(run).rejects.toThrow('timeout');
    await expectAllDead(started);
    expect(runner.running).toBe(0);
  });

  posixOnly('kills the whole process group at the output cap and returns what fit', async () => {
    const { runner, pids } = await fakeGit('flood-git', 'while :; do echo 0123456789abcdef; done');
    const result = await runner.run(fixture.realRoot, ['log'], { signal: signal(), maxBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(4096);
    await expectAllDead(await pids());
  });

  posixOnly('kills live groups on server shutdown', async () => {
    const { runner, pids } = await fakeGit('stuck-git', 'wait');
    const run = runner.run(fixture.realRoot, ['status'], { signal: signal(), maxBytes: 1024 });
    const started = await pids();
    runner.killAll();
    await expect(run).resolves.toMatchObject({ code: null, signal: 'SIGKILL' });
    await expectAllDead(started);
  });

  posixOnly('runs at most two git children at once and times out waiters', async () => {
    const log = path.join(fixture.outside, 'concurrency.log');
    const script = path.join(fixture.outside, 'queued-git');
    await writeFile(script, `#!/bin/sh\necho start >> '${log}'\nsleep 0.3\necho end >> '${log}'\n`);
    await chmod(script, 0o755);
    const runner = new GitRunner({ gitPath: script, roots: [fixture.realRoot] });
    await Promise.all(Array.from({ length: 5 }, () => runner.run(fixture.realRoot, [], { signal: signal(), maxBytes: 64 })));
    let running = 0;
    let peak = 0;
    for (const line of (await readFile(log, 'utf8')).trim().split('\n')) {
      running += line === 'start' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);

    const blocked = [runner.run(fixture.realRoot, [], { signal: signal(), maxBytes: 64 }), runner.run(fixture.realRoot, [], { signal: signal(), maxBytes: 64 })];
    const waiting = runner.run(fixture.realRoot, [], { signal: AbortSignal.timeout(50), maxBytes: 64 });
    await expect(waiting).rejects.toThrow();
    await Promise.all(blocked);
  });

  posixOnly('turns a failed git into GIT_FAILED without its stderr, and audits only the exit code', async () => {
    const script = path.join(fixture.outside, 'failing-git');
    await writeFile(script, `#!/bin/sh\necho "fatal: ${fixture.realRoot}/.env is broken" >&2\nexit 3\n`);
    await chmod(script, 0o755);
    const runner = new GitRunner({ gitPath: script, roots: [fixture.realRoot] });
    const result = await runner.run(fixture.realRoot, ['status'], { signal: signal(), maxBytes: 64 });
    expect(result.stderr).toContain('is broken');
    let failure: unknown;
    try {
      assertGitSucceeded(result);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect(failure).toMatchObject({ code: 'GIT_FAILED', detail: 'exit:3' });
    expectNoHostPath((failure as Error).message, fixture);
    expect((failure as Error).message).not.toContain('broken');

    const records: unknown[] = [];
    const response = await runTool(
      { tool: 'git_status', requestId: 1, timeoutMs: 1000, audit: (record) => records.push(record) },
      async () => {
        assertGitSucceeded(result);
        return { result: {} };
      },
    );
    expect(JSON.stringify(response)).not.toContain('broken');
    expect(records).toEqual([expect.objectContaining({ ok: false, error_code: 'GIT_FAILED', error_detail: 'exit:3' })]);
  });

  it('audits truncated calls', async () => {
    const records: unknown[] = [];
    await runTool({ tool: 'git_log', requestId: 2, timeoutMs: 1000, audit: (record) => records.push(record) }, async () => ({
      result: { truncated: true },
      bytesRead: 10,
      truncated: true,
    }));
    expect(records).toEqual([expect.objectContaining({ ok: true, bytes_read: 10, truncated: true })]);
  });
});

describe('Windows process tree and 8.3 aliases (ADR-004 §2.10)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    await initRepository(fixture);
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  type ProcessEntry = { ProcessId: number; ParentProcessId: number; ExecutablePath: string };
  /** git.exe processes whose command line carries `marker`, via CIM (test-only process listing). */
  const gitProcesses = (marker: string): ProcessEntry[] => {
    const json = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (json === '') return [];
    const parsed = JSON.parse(json) as ProcessEntry | ProcessEntry[];
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  const waitFor = async <T>(probe: () => T, done: (value: T) => boolean): Promise<T> => {
    let value = probe();
    for (let attempt = 0; attempt < 50 && !done(value); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = probe();
    }
    return value;
  };
  /** Starts `cat-file --batch`, which blocks on the open stdin until killed. */
  const startBlocked = (binary: string, marker: string) =>
    spawn(binary, [...gitGlobalArgs(), '-c', `test.marker=${marker}`, 'cat-file', '--batch'], {
      cwd: fixture.realRoot,
      env: { ...buildGitEnv(process.env, [fixture.realRoot]), GIT_DIR: path.join(fixture.realRoot, '.git'), GIT_WORK_TREE: fixture.realRoot },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });

  windowsOnly('runs the real git binary, so killing the child leaves no git process behind (M67)', async () => {
    const launcher = await findGit(hardenedPath(process.env, []), []);
    expect(launcher).toBeDefined();
    expect(gitPath.toLowerCase()).toMatch(/[\\/]bin[\\/]git\.exe$/);
    expect(gitPath.toLowerCase()).not.toBe(launcher?.toLowerCase());

    // Control: the PATH launcher starts the real git as a child, which a plain kill does not reach.
    const controlMarker = randomUUID();
    const control = startBlocked(launcher as string, controlMarker);
    const tree = await waitFor(() => gitProcesses(controlMarker), (found) => found.length >= 2);
    expect(tree.map((entry) => entry.ParentProcessId)).toContain(control.pid);
    control.kill('SIGKILL');
    for (const entry of gitProcesses(controlMarker)) process.kill(entry.ProcessId);

    const marker = randomUUID();
    const child = startBlocked(gitPath, marker);
    const running = await waitFor(() => gitProcesses(marker), (found) => found.length >= 1);
    expect(running).toEqual([expect.objectContaining({ ProcessId: child.pid })]);
    // The runner's Windows termination (M60) is exactly this call.
    child.kill('SIGKILL');
    expect(await waitFor(() => gitProcesses(marker), (found) => found.length === 0)).toEqual([]);
  }, 30_000);

  windowsOnly('treats the 8.3 alias GIT~1 exactly like .git (M66)', async () => {
    expect(existsSync(path.join(fixture.realRoot, 'GIT~1')), '8.3 names are disabled on this volume; re-check ADR-004 §2.10').toBe(true);
    const guard = new PathGuard(fixture.realRoot);
    for (const target of ['GIT~1', 'GIT~1/config', 'GIT~1/hooks', 'git~1/HEAD']) {
      await expectWorkspaceError(guard.resolveExisting(target), 'PATH_BLOCKED');
    }
    for (const target of ['GIT~1/config', 'GIT~1/hooks/pre-commit', 'GIT~1/new-dir/file']) {
      await expectWorkspaceError(guard.resolveForWrite(target), 'PATH_BLOCKED');
      await expectWorkspaceError(guard.checkMaybeMissing(target), 'PATH_BLOCKED');
    }
    // Other short names behave the same, e.g. ENV~1 for .env.
    await expectWorkspaceError(guard.resolveExisting('ENV~1'), 'PATH_BLOCKED');
    const ctx = contextFor(fixture);
    await expectWorkspaceError(gitLog(ctx, { path: 'GIT~1/config' }, signal()), 'PATH_BLOCKED');
    await expectWorkspaceError(gitDiff(ctx, { path: 'GIT~1' }, signal()), 'PATH_BLOCKED');
  });
});
