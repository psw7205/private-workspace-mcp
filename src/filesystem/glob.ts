import { WorkspaceError } from '../errors/errors.js';

/** Upper bound on the patterns one brace expression may expand to. */
const MAX_EXPANSIONS = 64;
/** Longest accepted glob; together with MAX_EXPANSIONS it bounds the cost of one match. */
export const MAX_GLOB_LENGTH = 256;

/** One code point of a segment pattern. */
type Token =
  | { kind: 'char'; value: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; ranges: [number, number][] };

/** Brace and separator markers exist only until alternatives are expanded and split into segments. */
type Lexeme = Token | { kind: 'open' } | { kind: 'comma' } | { kind: 'close' } | { kind: 'slash' };

/**
 * Compiles a client-supplied glob into a matcher for `/`-separated relative paths.
 *
 * Syntax: `*` and `?` match within one segment, `**` as a whole segment matches zero or
 * more segments, `[abc]`, `[a-z]`, and `[!a]` (or `[^a]`) match one character of a set, and
 * `{a,b}` (not nested, at most 64 expansions) lists alternatives. `\` makes the next
 * character literal. Every other character is literal: no extglobs or numeric ranges.
 * Characters are code points. `*`, `?`, `**`, and classes never match a segment that starts
 * with `.`; name it explicitly. Matching is case-sensitive on every platform.
 *
 * The matcher runs in polynomial time (a segment NFA over a two-pointer wildcard match),
 * unlike path.matchesGlob, whose brace expansion and extglob regexes can block the event
 * loop for minutes on short patterns. Segment parts are shared across alternatives and each
 * (part, path segment) pair is matched at most once per candidate.
 */
export function compileGlob(pattern: string): (candidate: string) => boolean {
  if (pattern.length > MAX_GLOB_LENGTH) throw invalidPattern(`must be at most ${MAX_GLOB_LENGTH} characters`);
  const parts: Token[][] = [];
  const partIds = new Map<string, number>();
  const alternatives = expandBraces(lex(pattern.replace(/^(\.\/)+/, ''))).map((alternative) =>
    toSegments(alternative).map((part) => {
      if (part === GLOBSTAR) return GLOBSTAR;
      const key = JSON.stringify(part);
      let id = partIds.get(key);
      if (id === undefined) {
        id = parts.push(part) - 1;
        partIds.set(key, id);
      }
      return id;
    }),
  );

  return (candidate) => {
    const segments = candidate.split('/');
    const characters = segments.map((segment) => Array.from(segment));
    // memo[segment * parts.length + part]: 0 unknown, 1 match, 2 no match.
    const memo = new Uint8Array(segments.length * parts.length);
    const matchPart = (part: number, segment: number): boolean => {
      const slot = segment * parts.length + part;
      if (memo[slot] === 0) memo[slot] = matchSegment(parts[part] as Token[], characters[segment] as string[]) ? 1 : 2;
      return memo[slot] === 1;
    };
    return alternatives.some((alternative) => matchSegments(alternative, segments, matchPart));
  };
}

/** Marks a `**` segment in a compiled alternative; other entries index into the shared parts. */
const GLOBSTAR = -1;

function lex(pattern: string): Lexeme[] {
  const chars = Array.from(pattern);
  const lexemes: Lexeme[] = [];
  let inBraces = false;
  let index = 0;
  const literal = (): string => {
    const next = chars[++index];
    if (next === undefined) throw invalidPattern('ends with "\\"');
    if (next === '/') throw invalidPattern('must not escape "/"');
    return next;
  };

  for (; index < chars.length; index++) {
    const char = chars[index] as string;
    if (char === '\\') {
      lexemes.push({ kind: 'char', value: literal() });
    } else if (char === '*') {
      lexemes.push({ kind: 'star' });
    } else if (char === '?') {
      lexemes.push({ kind: 'any' });
    } else if (char === '/') {
      lexemes.push({ kind: 'slash' });
    } else if (char === '{') {
      if (inBraces) throw invalidPattern('must not nest braces');
      inBraces = true;
      lexemes.push({ kind: 'open' });
    } else if (char === '}') {
      if (!inBraces) throw invalidPattern('has a "}" without a matching "{"');
      inBraces = false;
      lexemes.push({ kind: 'close' });
    } else if (char === ',' && inBraces) {
      lexemes.push({ kind: 'comma' });
    } else if (char === '[') {
      index++;
      const negated = chars[index] === '!' || chars[index] === '^';
      if (negated) index++;
      const ranges: [number, number][] = [];
      // As in POSIX, a "]" right after "[" or "[!" is a member, not the end of the class.
      for (let first = true; ; first = false, index++) {
        let member = chars[index];
        if (member === undefined) throw invalidPattern('has a "[" without a matching "]"');
        if (member === ']' && !first) break;
        if (member === '/') throw invalidPattern('must not have "/" inside "[...]"');
        if (member === '\\') member = literal();
        let last = member;
        if (chars[index + 1] === '-' && chars[index + 2] !== undefined && chars[index + 2] !== ']') {
          index += 2;
          last = chars[index] as string;
          if (last === '/') throw invalidPattern('must not have "/" inside "[...]"');
          if (last === '\\') last = literal();
        }
        const range: [number, number] = [member.codePointAt(0) as number, last.codePointAt(0) as number];
        if (range[0] > range[1]) throw invalidPattern(`has a reversed range "${member}-${last}"`);
        ranges.push(range);
      }
      lexemes.push({ kind: 'class', negated, ranges });
    } else {
      lexemes.push({ kind: 'char', value: char });
    }
  }
  if (inBraces) throw invalidPattern('has a "{" without a matching "}"');
  return lexemes;
}

function expandBraces(lexemes: Lexeme[]): Lexeme[][] {
  let results: Lexeme[][] = [[]];
  for (let index = 0; index < lexemes.length; index++) {
    if (lexemes[index]?.kind !== 'open') {
      for (const result of results) result.push(lexemes[index] as Lexeme);
      continue;
    }
    const options: Lexeme[][] = [[]];
    for (index++; lexemes[index]?.kind !== 'close'; index++) {
      const lexeme = lexemes[index] as Lexeme;
      if (lexeme.kind === 'comma') options.push([]);
      else options.at(-1)?.push(lexeme);
    }
    if (results.length * options.length > MAX_EXPANSIONS) {
      throw invalidPattern(`expands to more than ${MAX_EXPANSIONS} alternatives`);
    }
    results = results.flatMap((prefix) => options.map((option) => [...prefix, ...option]));
  }
  return results;
}

function invalidPattern(reason: string): WorkspaceError {
  return new WorkspaceError('INVALID_PATH', `glob pattern ${reason}`);
}

/** Splits on `/`, drops empty segments, and collapses repeated `**`. */
function toSegments(lexemes: Lexeme[]): (Token[] | typeof GLOBSTAR)[] {
  const segments: (Token[] | typeof GLOBSTAR)[] = [];
  let current: Token[] = [];
  const flush = () => {
    const globstar = current.length === 2 && current.every((token) => token.kind === 'star');
    if (current.length > 0 && !(globstar && segments.at(-1) === GLOBSTAR)) segments.push(globstar ? GLOBSTAR : current);
    current = [];
  };
  for (const lexeme of lexemes) {
    if (lexeme.kind === 'slash') flush();
    else current.push(lexeme as Token);
  }
  flush();
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

function matchToken(token: Token, char: string): boolean {
  switch (token.kind) {
    case 'char':
      return token.value === char;
    case 'any':
      return true;
    case 'class': {
      const point = char.codePointAt(0) as number;
      return token.ranges.some(([first, last]) => first <= point && point <= last) !== token.negated;
    }
    case 'star':
      return false;
  }
}

/** Wildcard match in O(pattern × segment) time, backtracking only to the last `*`. */
function matchSegment(pattern: Token[], segment: string[]): boolean {
  if (segment[0] === '.') {
    const head = pattern[0];
    if (head?.kind !== 'char' || head.value !== '.') return false;
  }
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < segment.length) {
    const token = pattern[p];
    if (token !== undefined && matchToken(token, segment[s] as string)) {
      p++;
      s++;
    } else if (token?.kind === 'star') {
      star = p++;
      resume = s;
    } else if (star !== -1) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p]?.kind === 'star') p++;
  return p === pattern.length;
}
