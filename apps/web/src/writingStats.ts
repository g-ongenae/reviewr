const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Number of characters, counting each Unicode code point once (an emoji is one character, not two). */
export const countCharacters = (text: string): number => {
  let count = text.length;
  for (let i = 0; i < text.length; i++) {
    if (isLowSurrogate(text.charCodeAt(i))) count--;
  }
  return count;
};

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

/**
 * Myers' diff of two token lists, as the runs that differ. Gives up (undefined) past `maxEdits` inserted plus deleted
 * tokens, which bounds both time and memory.
 */
const diffTokens = (a: readonly string[], b: readonly string[], maxEdits: number): Hunk[] | undefined => {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const at = (k: number) => v[offset + k] ?? 0;
  // trace[d] keeps v for diagonals -d-1..d+1 as it was before step d, to walk the path back.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return undefined;
};

const backtrack = (trace: readonly Int32Array[], n: number, m: number): Hunk[] => {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const band = trace[d] ?? new Int32Array(0);
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
    const last = hunks.at(-1);
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

const splitParagraphs = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
const splitWords = (text: string): string[] => text.match(/\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu) ?? [];
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
  while (prefix < shortest && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) {
    suffix++;
  }
  const cuts = (text: string, at: number) =>
    at > 0 &&
    at < text.length &&
    (wholeWords
      ? isWordUnit(text, at - 1) && isWordUnit(text, at)
      : isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at)));
  while (prefix > 0 && (cuts(a, prefix) || cuts(b, prefix))) prefix--;
  while (suffix > 0 && (cuts(a, a.length - suffix) || cuts(b, b.length - suffix))) suffix--;
  return [prefix, suffix];
};

/** Replaced words are compared letter by letter only when they mostly match (a typo fix), not for another word. */
const areAlike = (before: string, after: string, deleted: number): boolean =>
  (countCharacters(before) - deleted) * 2 > Math.max(countCharacters(before), countCharacters(after));

const measure = (before: string, after: string, level: number, changes: CharacterChanges): void => {
  const split = levels[level];
  const [prefix, suffix] = commonEnds(before, after, split !== undefined && split !== splitCharacters);
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const countWhole = () => {
    changes.deleted += countCharacters(a);
    changes.added += countCharacters(b);
  };

  if (a.length === 0 || b.length === 0 || split === undefined) return countWhole();
  if (split === splitCharacters && (a.length > maxCharacterLevelLength || b.length > maxCharacterLevelLength)) {
    return countWhole();
  }
  const aTokens = split(a);
  const bTokens = split(b);
  const hunks = diffTokens(aTokens, bTokens, maxEditsPerLevel);
  if (hunks === undefined) return countWhole(); // Rewritten too much to tell apart: count it all.
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
  if (before !== after) measure(before, after, 0, changes);
  return changes;
};
