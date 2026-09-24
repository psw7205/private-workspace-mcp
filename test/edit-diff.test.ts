import { describe, expect, it } from 'vitest';

import { EditTracker, MAX_DIFF_BYTES, unifiedDiff } from '../src/filesystem/edit-diff.js';

type Edit = [oldString: string, newString: string];

/** Applies edits the way file-editor does (every occurrence) and returns the diff. */
function diffOf(before: string, edits: Edit[], maxBytes = MAX_DIFF_BYTES) {
  const tracker = new EditTracker(before.length);
  let content = before;
  for (const [oldString, newString] of edits) {
    const parts = content.split(oldString);
    tracker.apply(parts, oldString.length, newString.length);
    content = parts.join(newString);
  }
  return { after: content, ...unifiedDiff('f.txt', before, content, tracker, maxBytes) };
}

/** A strict unified diff applier: context and removed lines must match `before` exactly. */
function applyDiff(before: string, diff: string): string {
  if (diff === '') return before;
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const rows = diff.split('\n');
  expect(rows.shift()).toBe('--- a/f.txt');
  expect(rows.shift()).toBe('+++ b/f.txt');
  expect(rows.pop()).toBe('');
  const out: string[] = [];
  let next = 0;
  let oldCount = 0;
  let newCount = 0;
  let last: { list: string[]; index: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(row);
    if (header) {
      expect(oldCount).toBe(0);
      expect(newCount).toBe(0);
      oldCount = header[2] === undefined ? 1 : Number(header[2]);
      newCount = header[4] === undefined ? 1 : Number(header[4]);
      const start = oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1;
      expect(start).toBeGreaterThanOrEqual(next);
      out.push(...lines.slice(next, start));
      next = start;
      // The new-side start must point at the same place in the output built so far.
      expect(out.length).toBe(newCount === 0 ? Number(header[3]) : Number(header[3]) - 1);
      continue;
    }
    if (row === '\\ No newline at end of file') {
      for (const { list, index } of last) list[index] = (list[index] as string).replace(/\n$/, '');
      continue;
    }
    const body = `${row.slice(1)}\n`;
    const marker = row[0];
    last = [];
    if (marker === ' ' || marker === '-') {
      const original = lines[next] as string;
      // The file's last line may lack "\n"; the marker row that follows says so.
      const noEol = rows[i + 1] === '\\ No newline at end of file';
      expect(noEol ? `${original}\n` : original).toBe(body);
      next++;
      oldCount--;
    }
    if (marker === ' ' || marker === '+') {
      out.push(body);
      newCount--;
      if (rows[i + 1] === '\\ No newline at end of file') last.push({ list: out, index: out.length - 1 });
    }
    if (marker !== ' ' && marker !== '-' && marker !== '+') throw new Error(`bad diff row ${JSON.stringify(row)}`);
  }
  expect(oldCount).toBe(0);
  expect(newCount).toBe(0);
  out.push(...lines.slice(next));
  return out.join('');
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('');

describe('unifiedDiff', () => {
  it('shows a one-line change with three lines of context', () => {
    const { diff, truncated } = diffOf(numbered(10), [['line 5\n', 'five\n']]);
    expect(truncated).toBe(false);
    expect(diff).toBe(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+five',
        ' line 6',
        ' line 7',
        ' line 8',
        '',
      ].join('\n'),
    );
  });

  it('shows a change inside a line as the whole line', () => {
    const { diff } = diffOf('alpha beta gamma\n', [['beta', 'BETA']]);
    expect(diff).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-alpha beta gamma\n+alpha BETA gamma\n');
  });

  it('keeps distant edits in separate hunks and merges close ones', () => {
    const far = diffOf(numbered(20), [['line 2\n', 'two\n'], ['line 18\n', 'eighteen\n']]).diff;
    expect(far.match(/^@@/gm)).toHaveLength(2);
    expect(far).toContain('@@ -1,5 +1,5 @@\n line 1\n-line 2\n+two\n');
    expect(far).toContain('@@ -15,6 +15,6 @@\n line 15\n line 16\n line 17\n-line 18\n+eighteen\n line 19\n line 20\n');

    // Six unchanged lines between two changes still fit in one hunk (2 x 3 context lines).
    const close = diffOf(numbered(20), [['line 5\n', 'five\n'], ['line 12\n', 'twelve\n']]).diff;
    expect(close.match(/^@@/gm)).toHaveLength(1);
    expect(close).toContain('@@ -2,14 +2,14 @@');
  });

  it('merges edits on adjacent lines and on the same line', () => {
    const adjacent = diffOf(numbered(5), [['line 2', 'two'], ['line 3', 'three']]).diff;
    expect(adjacent).toBe(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n line 1\n-line 2\n-line 3\n+two\n+three\n line 4\n line 5\n',
    );
    const sameLine = diffOf('a b c\n', [['a', 'A'], ['c', 'C']]).diff;
    expect(sameLine).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a b c\n+A b C\n');
  });

  it('follows sequential edits that rewrite the result of earlier edits', () => {
    const { diff, after } = diffOf(numbered(6), [
      ['line 2\nline 3\n', 'X\n'],
      ['X\nline 4', 'Y\nline 4!'],
      ['line 1', 'first'],
    ]);
    expect(after).toBe('first\nY\nline 4!\nline 5\nline 6\n');
    expect(diff).toBe(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,6 +1,5 @@\n-line 1\n-line 2\n-line 3\n-line 4\n+first\n+Y\n+line 4!\n line 5\n line 6\n',
    );
  });

  it('shows pure insertions and deletions without touching neighbours', () => {
    const inserted = diffOf('a\nb\nc\n', [['b\n', 'b\nnew\n']]).diff;
    expect(inserted).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n b\n+new\n c\n');
    const deleted = diffOf('a\nb\nc\n', [['b\n', '']]).diff;
    expect(deleted).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,2 @@\n a\n-b\n c\n');
    const atStart = diffOf('a\nb\n', [['a\n', '']]).diff;
    expect(atStart).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1 @@\n-a\n b\n');
    const emptied = diffOf('only\n', [['only\n', '']]).diff;
    expect(emptied).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1 +0,0 @@\n-only\n');
  });

  it('returns an empty diff when the content does not change', () => {
    expect(diffOf(numbered(3), [['line 2', 'line 2']])).toMatchObject({ diff: '', truncated: false });
    // A change that is undone by a later edit leaves no hunk either.
    expect(diffOf(numbered(3), [['line 2', 'x'], ['x', 'line 2']]).diff).toBe('');
  });

  it('marks a last line without a newline', () => {
    const changed = diffOf('a\nb', [['b', 'B']]).diff;
    expect(changed).toBe(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n',
    );
    const added = diffOf('a\nb', [['b', 'b\n']]).diff;
    expect(added).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    const context = diffOf('a\nb\nc', [['a', 'A']]).diff;
    expect(context).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n-a\n+A\n b\n c\n\\ No newline at end of file\n');
  });

  it('keeps CRLF line endings inside the lines', () => {
    const { diff } = diffOf('one\r\ntwo\r\nthree\r\n', [['two', 'TWO']]);
    expect(diff).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\r\n-two\r\n+TWO\r\n three\r\n');
    const toLf = diffOf('one\r\ntwo\r\n', [['\r\n', '\n']]).diff;
    expect(toLf).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-one\r\n-two\r\n+one\n+two\n');
  });

  it('truncates at a line boundary under the byte limit', () => {
    const before = numbered(2000);
    const { diff, truncated, after } = diffOf(before, [['line', 'LINE']], 1024);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(1024);
    expect(diff.endsWith('\n')).toBe(true);
    expect(diff.startsWith('--- a/f.txt\n+++ b/f.txt\n@@ -1,2000 +1,2000 @@\n-line 1\n')).toBe(true);
    expect(after).not.toBe(before);

    const full = diffOf(before, [['line', 'LINE']]);
    expect(full.truncated).toBe(false);
    expect(Buffer.byteLength(full.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(MAX_DIFF_BYTES).toBe(64 * 1024);
  });

  it('stays linear for a replace_all over every line', () => {
    const before = numbered(100_000);
    const started = performance.now();
    const { truncated } = diffOf(before, [['line', 'LINE']]);
    expect(truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('stays linear for many replacements on one long line', () => {
    const before = 'ab'.repeat(1 << 19);
    const started = performance.now();
    const { truncated, diff } = diffOf(before, [['a', 'x']]);
    expect(truncated).toBe(true);
    expect(diff).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n');
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('produces a diff that turns the old content into the new content (random edits)', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 42;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = ['a', 'b', 'c', '\n', '\r\n', 'ab\n', ' '];
    for (let round = 0; round < 500; round++) {
      let before = '';
      const length = random(60);
      for (let i = 0; i < length; i++) before += alphabet[random(alphabet.length)];
      const edits: Edit[] = [];
      let content = before;
      for (let e = 0; e < 1 + random(4); e++) {
        if (content.length === 0) break;
        const start = random(content.length);
        const oldString = content.slice(start, start + 1 + random(6));
        let newString = '';
        for (let i = 0; i < random(5); i++) newString += alphabet[random(alphabet.length)];
        edits.push([oldString, newString]);
        content = content.split(oldString).join(newString);
      }
      const { diff, after } = diffOf(before, edits);
      expect(after).toBe(content);
      expect(applyDiff(before, diff), JSON.stringify({ before, edits, diff })).toBe(after);
      if (before === after) expect(diff).toBe('');
    }
  });
});
