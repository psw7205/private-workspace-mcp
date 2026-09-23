import { WorkspaceError } from '../errors/errors.js';

/** Upper bound on the patterns one brace expression may expand to. */
const MAX_EXPANSIONS = 64;
/** Longest accepted glob; together with MAX_EXPANSIONS it bounds the cost of one match. */
export const MAX_GLOB_LENGTH = 256;

/**
 * Compiles a client-supplied glob into a matcher for `/`-separated relative paths.
 *
 * Syntax: `*` and `?` match within one segment, `**` as a whole segment matches zero or
 * more segments, and `{a,b}` (not nested, at most 64 expansions) lists alternatives.
 * Every other character is literal: no extglobs, character classes, or numeric ranges.
 * `*`, `?`, and `**` never match a segment that starts with `.`; name it explicitly.
 * Matching is case-sensitive on every platform.
 *
 * The matcher runs in polynomial time (a segment NFA over a two-pointer wildcard match),
 * unlike path.matchesGlob, whose brace expansion and extglob regexes can block the event
 * loop for minutes on short patterns. Segment parts are shared across alternatives and each
 * (part, path segment) pair is matched at most once per candidate.
 */
export function compileGlob(pattern: string): (candidate: string) => boolean {
  if (pattern.length > MAX_GLOB_LENGTH) throw invalidPattern(`must be at most ${MAX_GLOB_LENGTH} characters`);
  const parts: string[] = [];
  const partIds = new Map<string, number>();
  const alternatives = expandBraces(pattern.replace(/^(\.\/)+/, '')).map((alternative) =>
    toSegments(alternative).map((part) => {
      if (part === '**') return GLOBSTAR;
      let id = partIds.get(part);
      if (id === undefined) {
        id = parts.push(part) - 1;
        partIds.set(part, id);
      }
      return id;
    }),
  );

  return (candidate) => {
    const segments = candidate.split('/');
    // memo[segment * parts.length + part]: 0 unknown, 1 match, 2 no match.
    const memo = new Uint8Array(segments.length * parts.length);
    const matchPart = (part: number, segment: number): boolean => {
      const slot = segment * parts.length + part;
      if (memo[slot] === 0) memo[slot] = matchSegment(parts[part] as string, segments[segment] as string) ? 1 : 2;
      return memo[slot] === 1;
    };
    return alternatives.some((alternative) => matchSegments(alternative, segments, matchPart));
  };
}

/** Marks a `**` segment in a compiled alternative; other entries index into the shared parts. */
const GLOBSTAR = -1;

function expandBraces(pattern: string): string[] {
  let results = [''];
  let index = 0;
  while (index < pattern.length) {
    const open = pattern.indexOf('{', index);
    const strayClose = pattern.indexOf('}', index);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) throw invalidPattern('has a "}" without a matching "{"');
    if (open === -1) {
      results = results.map((prefix) => prefix + pattern.slice(index));
      break;
    }
    const close = pattern.indexOf('}', open);
    if (close === -1) throw invalidPattern('has a "{" without a matching "}"');
    if (pattern.slice(open + 1, close).includes('{')) throw invalidPattern('must not nest braces');

    const literal = pattern.slice(index, open);
    const options = pattern.slice(open + 1, close).split(',');
    if (results.length * options.length > MAX_EXPANSIONS) {
      throw invalidPattern(`expands to more than ${MAX_EXPANSIONS} alternatives`);
    }
    results = results.flatMap((prefix) => options.map((option) => prefix + literal + option));
    index = close + 1;
  }
  return results;
}

function invalidPattern(reason: string): WorkspaceError {
  return new WorkspaceError('INVALID_PATH', `glob pattern ${reason}`);
}

/** Splits on `/`, drops empty segments, and collapses repeated `**`. */
function toSegments(pattern: string): string[] {
  const segments: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment === '' || (segment === '**' && segments.at(-1) === '**')) continue;
    segments.push(segment);
  }
  return segments;
}

/** Simulates the segment pattern as an NFA; a `**` state may consume segments or be skipped. */
function matchSegments(
  pattern: number[],
  path: string[],
  matchPart: (part: number, segment: number) => boolean,
): boolean {
  const closure = (states: Set<number>): Set<number> => {
    for (const state of [...states].sort((a, b) => a - b)) {
      for (let next = state; pattern[next] === GLOBSTAR; next++) states.add(next + 1);
    }
    return states;
  };

  let states = closure(new Set([0]));
  for (let index = 0; index < path.length; index++) {
    const next = new Set<number>();
    for (const state of states) {
      const part = pattern[state];
      if (part === undefined) continue;
      if (part === GLOBSTAR) {
        if (!(path[index] as string).startsWith('.')) next.add(state);
      } else if (matchPart(part, index)) {
        next.add(state + 1);
      }
    }
    if (next.size === 0) return false;
    states = closure(next);
  }
  return states.has(pattern.length);
}

/** `*` and `?` wildcard match in O(pattern × segment) time, backtracking only to the last `*`. */
function matchSegment(pattern: string, segment: string): boolean {
  if (segment.startsWith('.') && !pattern.startsWith('.')) return false;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < segment.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === segment[s])) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = s;
    } else if (star !== -1) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
