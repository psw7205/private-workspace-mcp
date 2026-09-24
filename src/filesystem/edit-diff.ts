/** Upper bound on the UTF-8 size of a dry-run diff (M50). */
export const MAX_DIFF_BYTES = 64 * 1024;

/** Unchanged lines shown around each change, as in `diff -u`. */
const CONTEXT_LINES = 3;

/** A run of the edited content: copied from the original at `from`, or inserted text when `from` is -1. */
interface Segment {
  from: number;
  length: number;
}

/**
 * Tracks which parts of the edited content still come from the original, so the diff follows
 * the actual replacements instead of searching for differences (M50). Each edit is recorded
 * from the `split` result that file-editor already computes; the cost is linear in the number
 * of segments and matches.
 */
export class EditTracker {
  private segments: Segment[];

  constructor(originalLength: number) {
    this.segments = originalLength > 0 ? [{ from: 0, length: originalLength }] : [];
  }

  /** Records one edit: `parts` is the current content split on the old string. */
  apply(parts: readonly string[], oldLength: number, newLength: number): void {
    const next: Segment[] = [];
    let index = 0;
    let start = 0;
    // Copies [from, to) of the current content, in current coordinates, into `next`.
    const copy = (from: number, to: number) => {
      let at = from;
      while (at < to) {
        let segment = this.segments[index] as Segment;
        while (start + segment.length <= at) {
          start += segment.length;
          index++;
          segment = this.segments[index] as Segment;
        }
        const offset = at - start;
        const take = Math.min(segment.length - offset, to - at);
        push(next, { from: segment.from < 0 ? -1 : segment.from + offset, length: take });
        at += take;
      }
    };
    let cursor = 0;
    for (let k = 0; k < parts.length - 1; k++) {
      const match = cursor + (parts[k] as string).length;
      copy(cursor, match);
      if (newLength > 0) push(next, { from: -1, length: newLength });
      cursor = match + oldLength;
    }
    copy(cursor, cursor + (parts.at(-1) as string).length);
    this.segments = next;
  }

  /** Unchanged runs as [original offset, new offset, length], in order. */
  unchanged(): Array<[number, number, number]> {
    const runs: Array<[number, number, number]> = [];
    let position = 0;
    for (const { from, length } of this.segments) {
      if (from >= 0) runs.push([from, position, length]);
      position += length;
    }
    return runs;
  }
}

function push(segments: Segment[], segment: Segment): void {
  const last = segments.at(-1);
  if (last && last.from < 0 && segment.from < 0) last.length += segment.length;
  else if (last && last.from >= 0 && last.from + last.length === segment.from) last.length += segment.length;
  else segments.push(segment);
}

/** Line start offsets; lines keep their "\n", so a CRLF line keeps its "\r". */
function lineStarts(text: string): number[] {
  const starts = text.length > 0 ? [0] : [];
  for (let i = text.indexOf('\n'); i !== -1 && i + 1 < text.length; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** Index of the first line starting at or after `offset` (the line count for the end of the text). */
function lineIndex(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] as number) < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lineAt(text: string, starts: readonly number[], index: number): string {
  return text.slice(starts[index], starts[index + 1] ?? text.length);
}

/** Changed lines: before[oldStart, oldEnd) became after[newStart, newEnd). */
interface Block {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
}

/**
 * Builds a unified diff (`diff -u` format, 3 context lines) from the tracked edits. Every change
 * is widened to whole lines; the text around it is identical on both sides because it comes from
 * the same unchanged run. Output stops at a line boundary once it would exceed `maxBytes`.
 */
export function unifiedDiff(
  relativePath: string,
  before: string,
  after: string,
  tracker: EditTracker,
  maxBytes = MAX_DIFF_BYTES,
): DiffResult {
  const oldStarts = lineStarts(before);
  const newStarts = lineStarts(after);
  // Binary search, not a scan for "\n": a long line with many matches would make scanning quadratic.
  // The end of a text that ends in "\n" counts as the start of an empty last line.
  const lineStart = (text: string, starts: readonly number[], offset: number) =>
    offset === text.length && text.endsWith('\n') ? offset : (starts[lineIndex(starts, offset + 1) - 1] ?? 0);
  const lineEnd = (text: string, starts: readonly number[], offset: number) =>
    starts[lineIndex(starts, offset + 1)] ?? text.length;

  // Changed character ranges, widened to whole lines and merged where they share a line.
  const ranges: Array<[number, number, number, number]> = [];
  const addChange = (oldFrom: number, oldTo: number, newFrom: number, newTo: number) => {
    const range: [number, number, number, number] = [
      lineStart(before, oldStarts, oldFrom),
      lineEnd(before, oldStarts, oldTo),
      lineStart(after, newStarts, newFrom),
      lineEnd(after, newStarts, newTo),
    ];
    const last = ranges.at(-1);
    if (last && range[0] < last[1]) {
      last[1] = range[1];
      last[3] = range[3];
    } else {
      ranges.push(range);
    }
  };
  let oldAt = 0;
  let newAt = 0;
  for (const [from, to, length] of tracker.unchanged()) {
    if (from > oldAt || to > newAt) addChange(oldAt, from, newAt, to);
    oldAt = from + length;
    newAt = to + length;
  }
  if (oldAt < before.length || newAt < after.length) addChange(oldAt, before.length, newAt, after.length);

  // Line blocks without the identical lines the widening pulled in; blocks that touch are joined.
  const blocks: Block[] = [];
  for (const [oldFrom, oldTo, newFrom, newTo] of ranges) {
    let oldStart = lineIndex(oldStarts, oldFrom);
    let oldEnd = lineIndex(oldStarts, oldTo);
    let newStart = lineIndex(newStarts, newFrom);
    let newEnd = lineIndex(newStarts, newTo);
    while (oldStart < oldEnd && newStart < newEnd && lineAt(before, oldStarts, oldStart) === lineAt(after, newStarts, newStart)) {
      oldStart++;
      newStart++;
    }
    while (oldEnd > oldStart && newEnd > newStart && lineAt(before, oldStarts, oldEnd - 1) === lineAt(after, newStarts, newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }
    if (oldStart === oldEnd && newStart === newEnd) continue;
    const last = blocks.at(-1);
    if (last && last.oldEnd === oldStart) {
      last.oldEnd = oldEnd;
      last.newEnd = newEnd;
    } else {
      blocks.push({ oldStart, oldEnd, newStart, newEnd });
    }
  }
  if (blocks.length === 0) return { diff: '', truncated: false };

  const out: string[] = [];
  let size = 0;
  const emit = (row: string): boolean => {
    const rowBytes = Buffer.byteLength(row, 'utf8') + 1;
    if (size + rowBytes > maxBytes) return false;
    out.push(row);
    size += rowBytes;
    return true;
  };
  const emitLine = (marker: string, line: string): boolean =>
    line.endsWith('\n') ? emit(marker + line.slice(0, -1)) : emit(marker + line) && emit('\\ No newline at end of file');
  const range = (start: number, count: number) =>
    count === 1 ? `${start + 1}` : `${count === 0 ? start : start + 1},${count}`;

  let truncated = !(emit(`--- a/${relativePath}`) && emit(`+++ b/${relativePath}`));
  for (let first = 0; first < blocks.length && !truncated; ) {
    let last = first;
    while (
      last + 1 < blocks.length &&
      (blocks[last + 1] as Block).oldStart - (blocks[last] as Block).oldEnd <= 2 * CONTEXT_LINES
    ) {
      last++;
    }
    const head = blocks[first] as Block;
    const tail = blocks[last] as Block;
    const oldFrom = Math.max(0, head.oldStart - CONTEXT_LINES);
    const oldTo = Math.min(oldStarts.length, tail.oldEnd + CONTEXT_LINES);
    const newFrom = head.newStart - (head.oldStart - oldFrom);
    const newTo = tail.newEnd + (oldTo - tail.oldEnd);
    const rows = function* (): Generator<[string, string]> {
      let at = oldFrom;
      for (let i = first; i <= last; i++) {
        const block = blocks[i] as Block;
        for (; at < block.oldStart; at++) yield [' ', lineAt(before, oldStarts, at)];
        for (let j = block.oldStart; j < block.oldEnd; j++) yield ['-', lineAt(before, oldStarts, j)];
        for (let j = block.newStart; j < block.newEnd; j++) yield ['+', lineAt(after, newStarts, j)];
        at = block.oldEnd;
      }
      for (; at < oldTo; at++) yield [' ', lineAt(before, oldStarts, at)];
    };
    truncated = !emit(`@@ -${range(oldFrom, oldTo - oldFrom)} +${range(newFrom, newTo - newFrom)} @@`);
    for (const [marker, line] of truncated ? [] : rows()) {
      if (!emitLine(marker, line)) {
        truncated = true;
        break;
      }
    }
    first = last + 1;
  }
  return { diff: out.length > 0 ? `${out.join('\n')}\n` : '', truncated };
}
