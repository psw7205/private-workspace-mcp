import { describe, expect, it } from 'vitest';

import { compileGlob } from '../src/filesystem/glob.js';
import { WorkspaceError } from '../src/errors/errors.js';

describe('compileGlob', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/lib/a.ts', true],
    ['src/**', 'src/a/b/c.md', true],
    ['src/**', 'src', true],
    ['src/**/test/*.ts', 'src/test/a.ts', true],
    ['src/**/test/*.ts', 'src/x/y/test/a.ts', true],
    ['a?.md', 'ab.md', true],
    ['a?.md', 'a/.md', false],
    ['*.ts', 'A.TS', false],
    ['**/*.ts', '.hidden/a.ts', false],
    ['**/*.ts', 'a/.b.ts', false],
    ['.github/**/*.yml', '.github/workflows/ci.yml', true],
    ['**/.*', 'a/.env.local', true],
    ['*', '.gitignore', false],
    ['src/*.{ts,js}', 'src/a.js', true],
    ['src/*.{ts,js}', 'src/a.md', false],
    ['{src,test}/**/*.ts', 'test/a.ts', true],
    ['./src/a.ts', 'src/a.ts', true],
    ['a[1].ts', 'a[1].ts', true],
    ['+(a|b).ts', '+(a|b).ts', true],
    ['{1..3}.txt', '2.txt', false],
    ['{1..3}.txt', '1..3.txt', true],
  ])('%j matches %j: %s', (pattern, candidate, expected) => {
    expect(compileGlob(pattern)(candidate)).toBe(expected);
  });

  it.each(['{a,{b,c}}', '{a,b', 'a}b{'.repeat(1), '{a,b}'.repeat(7), 'a'.repeat(257)])('rejects %j', (pattern) => {
    expect(() => compileGlob(pattern)).toThrow(WorkspaceError);
  });

  // path.posix.matchesGlob took seconds to minutes on patterns like these.
  it.each([
    ['{1..100000}', 'a'.repeat(40)],
    ['+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)b', 'a'.repeat(40)],
    [`${'*a'.repeat(127)}b`, 'a'.repeat(250)],
    [`${'**/a/'.repeat(50)}b`, `${'a/'.repeat(60)}c`],
    // Worst cases found in review: many wildcards, 64 alternatives, adversarial long names.
    [
      `**/*${'?'.repeat(40)}{${Array.from({ length: 64 }, (_, index) => String.fromCharCode(0x4e00 + index)).join(',')}}`.slice(0, 256),
      Array(16).fill('a'.repeat(255)).join('/'),
    ],
    [`${'**/*?????a/'.repeat(18)}{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}Z`.slice(-256), Array(16).fill('a'.repeat(255)).join('/')],
  ])('matches pathological pattern %# quickly', (pattern, candidate) => {
    const started = performance.now();
    const matches = compileGlob(pattern);
    for (let index = 0; index < 5; index++) matches(candidate);
    // Locally the worst case takes ~40 ms per match; the bound only catches regressions to seconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
