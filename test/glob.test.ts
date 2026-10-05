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
    ['a[12].ts', 'a1.ts', true],
    ['a[12].ts', 'a3.ts', false],
    ['a[12].ts', 'a[12].ts', false],
    ['[a-c]x', 'bx', true],
    ['[a-c]x', 'dx', false],
    ['[!a-c]x', 'dx', true],
    ['[^a-c]x', 'bx', false],
    ['[]a]', ']', true],
    ['[]a]', 'a', true],
    ['[!]]', 'a', true],
    ['[!]]', ']', false],
    ['[a-]', '-', true],
    ['[-a]', '-', true],
    ['[\\]]', ']', true],
    ['[{]x', '{x', true],
    ['{[ab],c}x', 'bx', true],
    ['{[,]x,y}', ',x', true],
    ['a]b', 'a]b', true],
    ['\\{a,b\\}.txt', '{a,b}.txt', true],
    ['\\{a,b\\}.txt', 'a.txt', false],
    ['\\*', '*', true],
    ['\\*', 'a', false],
    ['a\\?', 'a?', true],
    ['a\\?', 'ab', false],
    ['\\\\', '\\', true],
    ['\\[1\\].ts', '[1].ts', true],
    ['a\\b', 'ab', true],
    ['{a\\,b,c}', 'a,b', true],
    ['{a\\,b,c}', 'c', true],
    ['{a\\,b,c}', 'a', false],
    ['[.]env', '.env', false],
    ['\\.env', '.env', true],
    ['?.txt', '\u{1F600}.txt', true],
    ['[\u{1F600}]', '\u{1F600}', true],
    ['[가-힣]', '한', true],
    ['+(a|b).ts', '+(a|b).ts', true],
    ['{1..3}.txt', '2.txt', false],
    ['{1..3}.txt', '1..3.txt', true],
  ])('%j matches %j: %s', (pattern, candidate, expected) => {
    expect(compileGlob(pattern)(candidate)).toBe(expected);
  });

  it.each([
    '{a,{b,c}}',
    '{a,b',
    'a}b{',
    '{a,b}'.repeat(7),
    'a'.repeat(257),
    'a[b',
    '[!]',
    '[z-a]',
    '[a/b]',
    'a\\',
    'a\\/b',
    '{a,b\\}',
  ])('rejects %j', (pattern) => {
    expect(() => compileGlob(pattern)).toThrow(WorkspaceError);
  });

  // path.posix.matchesGlob took seconds to minutes on patterns like these.
  it.each([
    ['{1..100000}', 'a'.repeat(40)],
    ['+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)b', 'a'.repeat(40)],
    [`${'*a'.repeat(127)}b`, 'a'.repeat(250)],
    [`${'**/a/'.repeat(50)}b`, `${'a/'.repeat(60)}c`],
    [`${'*[a-z]'.repeat(42)}!`, 'a'.repeat(250)],
    [
      `**/${'*[!b]'.repeat(10)}{${Array.from({ length: 48 }, (_, index) => `[${String.fromCharCode(0x4e00 + index)}]`).join(',')}}`,
      Array(16).fill('a'.repeat(255)).join('/'),
    ],
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
