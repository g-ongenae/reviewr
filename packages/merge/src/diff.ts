import { isInlineSpace, isLineBreak } from './tokenize.js';

/**
 * The tokens `a[aStart, aEnd)` replaced by `b[bStart, bEnd)`; one side may be empty (an insertion or a deletion).
 */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Past this many inserted plus deleted items, a Myers diff gives up and the whole run counts as replaced. It bounds the
 * time of one diff to about `(n + m) × maxEdits` comparisons, and its memory to `maxEdits²` integers.
 */
const maxEdits: number = 1000;

/**
 * Walk the Myers trace back from `(n, m)` to `(0, 0)`, as the runs that differ, in order.
 */
const backtrack = (trace: readonly Int32Array[], n: number, m: number): Hunk[] => {
  const hunks: Hunk[] = [];
  let x: number = n;
  let y: number = m;
  for (let d: number = trace.length - 1; d > 0; d--) {
    const band: Int32Array = trace[d] ?? new Int32Array(0);
    /**
     * Furthest x reached on diagonal k before step d.
     */
    const at = (k: number): number => band[k + d + 1] ?? 0;
    const k: number = x - y;
    const prevK: number = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX: number = at(prevK);
    const prevY: number = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    // One edit from (prevX, prevY) to (x, y): a deletion of a[prevX] or an insertion of b[prevY].
    const last: Hunk | undefined = hunks[hunks.length - 1];
    if (last !== undefined && last.aStart === x && last.bStart === y) {
      last.aStart = prevX;
      last.bStart = prevY;
    } else {
      hunks.push({ aStart: prevX, aEnd: x, bStart: prevY, bEnd: y });
    }
    x = prevX;
    y = prevY;
  }

  return hunks.reverse();
};

/* eslint-disable no-magic-numbers -- Myers' diagonals of one step are 2 apart, with a sentinel on each side. */
/**
 * Myers' shortest edit script between `a[aFrom, aTo)` and `b[bFrom, bTo)`, as hunks in the coordinates of `a` and `b`.
 * Undefined past {@link maxEdits}.
 */
const myers = (
  a: readonly string[],
  b: readonly string[],
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
): Hunk[] | undefined => {
  const n: number = aTo - aFrom;
  const m: number = bTo - bFrom;
  const limit: number = Math.min(n + m, maxEdits);
  const offset: number = limit + 1;
  const v: Int32Array = new Int32Array(2 * limit + 3);
  /**
   * Furthest x reached so far on diagonal k.
   */
  const at = (k: number): number => v[offset + k] ?? 0;
  // trace[d] keeps v for the diagonals -d-1..d+1 as it was before step d, to walk the path back.
  const trace: Int32Array[] = [];

  for (let d: number = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k: number = -d; k <= d; k += 2) {
      let x: number = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y: number = x - k;
      while (x < n && y < m && a[aFrom + x] === b[bFrom + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m).map((hunk: Hunk): Hunk => ({
          aStart: aFrom + hunk.aStart,
          aEnd: aFrom + hunk.aEnd,
          bStart: bFrom + hunk.bStart,
          bEnd: bFrom + hunk.bEnd,
        }));
      }
    }
  }

  return undefined;
};
/* eslint-enable no-magic-numbers */

/**
 * Diff of `a[aFrom, aTo)` and `b[bFrom, bTo)` that prefers the earliest matches: the common start is skipped, then
 * Myers runs on what is left (its greedy diagonals also match as early as they can). The common end is not skipped
 * first, as that would prefer the latest matches there. If the rest is too different, it counts as one replacement,
 * common end excluded.
 */
const diffRange = (
  a: readonly string[],
  b: readonly string[],
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
): Hunk[] => {
  let start: number = 0;
  while (aFrom + start < aTo && bFrom + start < bTo && a[aFrom + start] === b[bFrom + start]) {
    start++;
  }
  const [aStart, bStart] = [aFrom + start, bFrom + start];
  if (aStart === aTo && bStart === bTo) {
    return [];
  }
  if (aStart === aTo || bStart === bTo) {
    return [{ aStart, aEnd: aTo, bStart, bEnd: bTo }];
  }
  const hunks: Hunk[] | undefined = myers(a, b, aStart, aTo, bStart, bTo);
  if (hunks !== undefined) {
    return hunks;
  }
  let end: number = 0;
  while (aTo - end > aStart && bTo - end > bStart && a[aTo - end - 1] === b[bTo - end - 1]) {
    end++;
  }

  return [{ aStart, aEnd: aTo - end, bStart, bEnd: bTo - end }];
};

/**
 * Lines of a token list: each line is its tokens joined, line break included. `starts` has one more entry than `lines`,
 * the token count, so line `i` is the tokens `starts[i]` to `starts[i + 1]`. With `reversed` tokens, a line break
 * starts a line instead of ending it, so the lines are the original lines, reversed.
 */
const splitLines = (tokens: readonly string[], reversed: boolean): { lines: string[]; starts: number[] } => {
  const lines: string[] = [];
  const starts: number[] = [0];
  let line: string = '';
  tokens.forEach((token: string, index: number): void => {
    if (reversed && isLineBreak(token) && index > 0) {
      lines.push(line);
      starts.push(index);
      line = '';
    }
    line += token;
    if (!reversed && isLineBreak(token)) {
      lines.push(line);
      starts.push(index + 1);
      line = '';
    }
  });
  if (starts[starts.length - 1] !== tokens.length) {
    lines.push(line);
    starts.push(tokens.length);
  }

  return { lines, starts };
};

/**
 * Merge hunks separated only by spaces (no line break): a rewritten phrase becomes one change instead of one change per
 * word anchored on the spaces between them, so it is never interleaved with the other side's edits.
 */
const joinAcrossSpaces = (hunks: readonly Hunk[], a: readonly string[]): Hunk[] => {
  const joined: Hunk[] = [];
  for (const hunk of hunks) {
    const last: Hunk | undefined = joined[joined.length - 1];
    if (last !== undefined && a.slice(last.aEnd, hunk.aStart).every(isInlineSpace)) {
      last.aEnd = hunk.aEnd;
      last.bEnd = hunk.bEnd;
    } else {
      joined.push({ ...hunk });
    }
  }

  return joined;
};

/**
 * Token-level diff of `a` and `b`, preferring the earliest matches. Lines (paragraphs) are compared first, then the
 * tokens inside the lines that differ, which keeps a long chapter with scattered edits fast. Hunks only separated by
 * spaces are joined. `reversed` says the tokens are in reverse order, for the lines.
 */
const diffEarliest = (a: readonly string[], b: readonly string[], reversed: boolean): Hunk[] => {
  const aLines: { lines: string[]; starts: number[] } = splitLines(a, reversed);
  const bLines: { lines: string[]; starts: number[] } = splitLines(b, reversed);
  const lineHunks: Hunk[] = diffRange(aLines.lines, bLines.lines, 0, aLines.lines.length, 0, bLines.lines.length);
  const tokenHunks: Hunk[] = lineHunks.flatMap((hunk: Hunk): Hunk[] =>
    diffRange(
      a,
      b,
      aLines.starts[hunk.aStart] ?? 0,
      aLines.starts[hunk.aEnd] ?? a.length,
      bLines.starts[hunk.bStart] ?? 0,
      bLines.starts[hunk.bEnd] ?? b.length,
    ),
  );

  return joinAcrossSpaces(tokenHunks, a);
};

/**
 * Token-level diff of `a` and `b`, as the runs that differ, in order. `earliest` keeps the earliest of several equal
 * matches (deleting one of two identical sentences deletes the second); `latest` diffs the reversed tokens, so it
 * keeps the latest (and deletes the first).
 */
export const diffTokens = (a: readonly string[], b: readonly string[], prefer: 'earliest' | 'latest'): Hunk[] => {
  if (prefer === 'earliest') {
    return diffEarliest(a, b, false);
  }

  return diffEarliest([...a].reverse(), [...b].reverse(), true)
    .map((hunk: Hunk): Hunk => ({
      aStart: a.length - hunk.aEnd,
      aEnd: a.length - hunk.aStart,
      bStart: b.length - hunk.bEnd,
      bEnd: b.length - hunk.bStart,
    }))
    .reverse();
};
