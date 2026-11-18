/** The UTF-16 units that start and end a surrogate pair: a code point past U+FFFF, such as most emoji. */
const highSurrogates = { first: 0xd800, last: 0xdbff } as const;
const lowSurrogates = { first: 0xdc00, last: 0xdfff } as const;
/** Whether a UTF-16 unit starts a surrogate pair. */
const isHighSurrogate = (code: number) => code >= highSurrogates.first && code <= highSurrogates.last;
/** Whether a UTF-16 unit ends a surrogate pair. */
const isLowSurrogate = (code: number) => code >= lowSurrogates.first && code <= lowSurrogates.last;

/** Number of characters, counting each Unicode code point once (an emoji is one character, not two). */
export const countCharacters = (text: string): number => {
  let count = text.length;
  for (let i = 0; i < text.length; i++) {
    if (isLowSurrogate(text.charCodeAt(i))) {
      count--;
    }
  }

  return count;
};

/** Characters written and deleted. */
export interface CharacterChanges {
  added: number;
  deleted: number;
}

/** A run of `a[aStart, aEnd)` replaced by `b[bStart, bEnd)`; one side may be empty. */
interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Each step of Myers' diff reaches every other diagonal. */
const diagonalStep = 2;

/**
 * Myers' diff of two token lists, as the runs that differ. Gives up (undefined) past `maxEdits` inserted plus deleted
 * tokens, which bounds both time and memory.
 */
const diffTokens = (a: readonly string[], b: readonly string[], maxEdits: number): Hunk[] | undefined => {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  // One slot per diagonal from -limit-1 to limit+1.
  const v = new Int32Array(offset + offset + 1);
  /** How far the path on diagonal `k` reached. */
  const at = (k: number) => v[offset + k] ?? 0;
  // trace[d] keeps v for diagonals -d-1..d+1 as it was before step d, to walk the path back.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 1 + 1)); // Up to diagonal d + 1, included.
    for (let k = -d; k <= d; k += diagonalStep) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m);
      }
    }
  }

  return undefined;
};

/** The runs that differ, from the path `diffTokens` found: walked back from its end, one edit at a time. */
const backtrack = (trace: readonly Int32Array[], n: number, m: number): Hunk[] => {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const band = trace[d] ?? new Int32Array(0);
    /** How far the path on diagonal `k` reached before step `d`. */
    const at = (k: number) => band[k + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    // One edit from (prevX, prevY) to (x, y): a deletion of a[prevX] or an insertion of b[prevY].
    const last = hunks[hunks.length - 1];
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

/** Lines, each with its line break. */
const splitParagraphs = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
/** Words, runs of spaces, and single punctuation marks. */
const splitWords = (text: string): string[] => text.match(/\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu) ?? [];
/** Code points. */
const splitCharacters = (text: string): string[] => Array.from(text);

/** From coarse to fine: each level only looks inside the runs the previous one found different. */
const levels = [splitParagraphs, splitWords, splitCharacters];
const maxEditsPerLevel = 1000;
/** Longer replaced runs are not compared letter by letter. */
const maxCharacterLevelLength = 64;

const wordCharacter = /[\p{L}\p{N}\p{M}]/u;
/** Whether a UTF-16 unit is part of a word, or half of a surrogate pair (never cut in between either). */
const isWordUnit = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);

  return isHighSurrogate(code) || isLowSurrogate(code) || wordCharacter.test(text.charAt(index));
};

/**
 * Length of the common prefix and suffix of two strings. Never splits a surrogate pair, and, with `wholeWords`, never
 * cuts a word: words are compared as a whole first.
 */
const commonEnds = (a: string, b: string, wholeWords: boolean): [number, number] => {
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (suffix < shortest - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) {
    suffix++;
  }
  /** Whether cutting `text` at `at` would split a word, or a surrogate pair. */
  const cuts = (text: string, at: number) =>
    at > 0 &&
    at < text.length &&
    (wholeWords
      ? isWordUnit(text, at - 1) && isWordUnit(text, at)
      : isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at)));
  while (prefix > 0 && (cuts(a, prefix) || cuts(b, prefix))) {
    prefix--;
  }
  while (suffix > 0 && (cuts(a, a.length - suffix) || cuts(b, b.length - suffix))) {
    suffix--;
  }

  return [prefix, suffix];
};

/** Kept letters must be more than half of the longer word. */
const alikeRatio = 2;
/** Replaced words are compared letter by letter only when they mostly match (a typo fix), not for another word. */
const areAlike = (before: string, after: string, deleted: number): boolean =>
  (countCharacters(before) - deleted) * alikeRatio > Math.max(countCharacters(before), countCharacters(after));

/** Adds to `changes` what was written and deleted from `before` to `after`, compared at `level` and finer. */
const measure = (before: string, after: string, level: number, changes: CharacterChanges): void => {
  const split = levels[level];
  const [prefix, suffix] = commonEnds(before, after, split !== undefined && split !== splitCharacters);
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  /** Counts the whole differing run as deleted and written. */
  const countWhole = () => {
    changes.deleted += countCharacters(a);
    changes.added += countCharacters(b);
  };

  if (a.length === 0 || b.length === 0 || split === undefined) {
    return countWhole();
  }
  if (split === splitCharacters && (a.length > maxCharacterLevelLength || b.length > maxCharacterLevelLength)) {
    return countWhole();
  }
  const aTokens = split(a);
  const bTokens = split(b);
  const hunks = diffTokens(aTokens, bTokens, maxEditsPerLevel);
  // Rewritten too much to tell apart: count it all.
  if (hunks === undefined) {
    return countWhole();
  }
  const local = { added: 0, deleted: 0 };
  for (const hunk of hunks) {
    measure(
      aTokens.slice(hunk.aStart, hunk.aEnd).join(''),
      bTokens.slice(hunk.bStart, hunk.bEnd).join(''),
      level + 1,
      local,
    );
  }
  if (split === splitCharacters && !areAlike(before, after, local.deleted)) {
    changes.deleted += countCharacters(before);
    changes.added += countCharacters(after);

    return;
  }
  changes.added += local.added;
  changes.deleted += local.deleted;
};

/**
 * Characters written and deleted to go from `before` to `after`. Paragraphs are compared first, then words inside the
 * paragraphs that changed, then letters inside the words that changed, so a rewritten passage counts as deleted and
 * written while a fixed typo counts one character.
 */
export const countCharacterChanges = (before: string, after: string): CharacterChanges => {
  const changes = { added: 0, deleted: 0 };
  if (before !== after) {
    measure(before, after, 0, changes);
  }

  return changes;
};

/** Number of words: the runs of characters between spaces and line breaks. */
export const countWords = (text: string): number => text.split(/\s+/u).filter((word) => word.length > 0).length;

/**
 * A count as the writing stats show it, with a comma every three digits (`12,345`). Written by hand rather than with
 * `Intl.NumberFormat`, so that the web and the phone, whose engines format numbers differently, show the same.
 */
export const formatCount = (value: number): string =>
  String(Math.abs(Math.trunc(value))).replace(/\B(?=(?:\d{3})+$)/gu, ',');

/** A change: `+12`, `−3` with a typographic minus so that numbers line up, or `0` without a sign. */
export const formatChange = (value: number): string => {
  if (value === 0) {
    return '0';
  }

  return `${value > 0 ? '+' : '−'}${formatCount(value)}`;
};
