import { diffTokens, type Hunk } from './diff.js';
import { isInlineSpace, tokenize } from './tokenize.js';

/**
 * Text that neither side changed.
 */
export interface UnchangedPart {
  kind: 'unchanged';
  text: string;
}

/**
 * A change made on one side only, or the same change made on both sides (`both`). It is already applied: `text`
 * replaces `base` in the merged text. Either may be empty (an insertion or a deletion).
 */
export interface ChangePart {
  kind: 'mine' | 'theirs' | 'both';
  base: string;
  text: string;
}

/**
 * Overlapping or adjacent changes from both sides, which the writer has to resolve: the region as it was in `base`,
 * and as each side left it.
 */
export interface ConflictPart {
  kind: 'conflict';
  base: string;
  mine: string;
  theirs: string;
}

/**
 * One run of the merged text, in order.
 */
export type MergePart = UnchangedPart | ChangePart | ConflictPart;

/**
 * Result of {@link mergeWords}: the merged text as parts, with the number of conflicts among them.
 */
export interface MergeResult {
  parts: MergePart[];
  conflicts: number;
}

/**
 * How the writer resolved one conflict: keep my text, keep theirs, keep both (mine, then theirs, exactly as written),
 * or replace the region with a text edited by hand.
 */
export type ConflictResolution = 'mine' | 'theirs' | 'both' | { edit: string };

/**
 * A change from one side, in base tokens: `base[start, end)` becomes `tokens`. When several alignments of that side
 * with the base are equally good (deleting one of two identical sentences), `[spanStart, spanEnd)` covers the base
 * tokens the change could also be read as touching.
 */
interface Edit {
  start: number;
  end: number;
  tokens: string[];
  spanStart: number;
  spanEnd: number;
}

/**
 * Marks a base token that the hunks change, in {@link keptAs}.
 */
const changed: number = -1;

/**
 * For each base token, the index of the side's token it is kept as, or {@link changed}.
 */
const keptAs = (baseLength: number, hunks: readonly Hunk[]): Int32Array => {
  const kept: Int32Array = new Int32Array(baseLength).fill(changed);
  let position: number = 0;
  let shift: number = 0;
  for (const hunk of hunks) {
    for (; position < hunk.aStart; position++) {
      kept[position] = position + shift;
    }
    position = hunk.aEnd;
    shift = hunk.bEnd - hunk.aEnd;
  }
  for (; position < baseLength; position++) {
    kept[position] = position + shift;
  }

  return kept;
};

/**
 * One side's changes, aligned with the base preferring the earliest matches. A base token is an anchor when the
 * alignments preferring the earliest and the latest matches both keep it, as the same token of the side. Each change's
 * span runs to the anchors around it: everything in between may be what that side changed.
 */
const sideEdits = (base: readonly string[], side: readonly string[]): Edit[] => {
  const earliest: Hunk[] = diffTokens(base, side, 'earliest');
  const keptEarliest: Int32Array = keptAs(base.length, earliest);
  const keptLatest: Int32Array = keptAs(base.length, diffTokens(base, side, 'latest'));
  /** `leftAnchor[i]`: the start of the run of non-anchors that ends at `i`. */
  const leftAnchor: Int32Array = new Int32Array(base.length + 1);
  /** `rightAnchor[i]`: the end of the run of non-anchors that starts at `i`. */
  const rightAnchor: Int32Array = new Int32Array(base.length + 1);
  /**
   * Whether both alignments keep the base token at `index` as the same token of the side.
   */
  const isAnchor = (index: number): boolean =>
    keptEarliest[index] !== changed && keptEarliest[index] === keptLatest[index];
  for (let index: number = 1; index <= base.length; index++) {
    leftAnchor[index] = isAnchor(index - 1) ? index : (leftAnchor[index - 1] ?? 0);
  }
  rightAnchor[base.length] = base.length;
  for (let index: number = base.length - 1; index >= 0; index--) {
    rightAnchor[index] = isAnchor(index) ? index : (rightAnchor[index + 1] ?? base.length);
  }

  return earliest.map((hunk: Hunk): Edit => ({
    start: hunk.aStart,
    end: hunk.aEnd,
    tokens: side.slice(hunk.bStart, hunk.bEnd),
    spanStart: leftAnchor[hunk.aStart] ?? hunk.aStart,
    spanEnd: rightAnchor[hunk.aEnd] ?? hunk.aEnd,
  }));
};

/**
 * The text of `base[start, end)` with the given edits (all inside that range, in order) applied.
 */
const applyEdits = (base: readonly string[], start: number, end: number, edits: readonly Edit[]): string => {
  let text: string = '';
  let position: number = start;
  for (const edit of edits) {
    text += base.slice(position, edit.start).join('') + edit.tokens.join('');
    position = edit.end;
  }

  return text + base.slice(position, end).join('');
};

/**
 * Builds the parts, merging consecutive unchanged runs.
 */
class PartList {
  public readonly parts: MergePart[] = [];
  public conflicts: number = 0;

  /**
   * Append text that did not change.
   */
  public unchanged(text: string): void {
    if (text === '') {
      return;
    }
    const last: MergePart | undefined = this.parts[this.parts.length - 1];
    if (last?.kind === 'unchanged') {
      last.text += text;
    } else {
      this.parts.push({ kind: 'unchanged', text });
    }
  }

  /**
   * Append a region that one side or both changed.
   */
  public changed(base: string, mine: string, theirs: string): void {
    if (mine === theirs) {
      this.parts.push({ kind: 'both', base, text: mine });
    } else if (mine === base) {
      this.parts.push({ kind: 'theirs', base, text: theirs });
    } else if (theirs === base) {
      this.parts.push({ kind: 'mine', base, text: mine });
    } else {
      this.parts.push({ kind: 'conflict', base, mine, theirs });
      this.conflicts++;
    }
  }
}

/**
 * Three-way merge, by word, of two texts that both started from `base`: `mine` (the local edits) and `theirs` (the
 * server's).
 *
 * Each side is compared with `base` token by token: words (with their inner apostrophes and hyphens), runs of spaces,
 * line breaks and punctuation marks. Then:
 *
 * - a change made by one side only is applied;
 * - the same change made on both sides is applied once;
 * - changes from the two sides that overlap are a conflict;
 * - so are adjacent changes: changes that touch (one ends where the other starts, or both insert at the same place),
 * or that are only separated by spaces on the same line (two neighbouring words). Changing `la fenêtre` into
 * `une fenêtre` on one side and into `la porte` on the other is a conflict, not `une porte`: the merge never decides
 * on its own how two edits of the same phrase fit together. Changes separated by a punctuation mark, a line break or
 * another word merge cleanly;
 * - over repeated text, each side is aligned with the base twice, over all its tokens: the shortest alignment
 * preferring the earliest of equal matches, and the one preferring the latest. A change covers, for the conflict test,
 * the base text between the nearest tokens both alignments keep as the same token of that side, so every token either
 * alignment changes counts. Deleting one of two identical sentences `Elle attend.` while the other side changes the
 * first into `Elle part.` is a conflict: nothing says which sentence was deleted. The same deletion merges cleanly
 * with a change elsewhere. Not covered: a third equally short alignment, a reading that takes more edits, and
 * token-level alternatives across an unchanged line when a side changed more than 2,000 tokens (see the README).
 *
 * Deterministic: the same three texts always give the same result. Every part's text is taken from the inputs, so
 * joining the parts as one side wrote them gives that side back.
 */
export const mergeWords = (base: string, mine: string, theirs: string): MergeResult => {
  const baseTokens: string[] = tokenize(base);
  const mineTokens: string[] = tokenize(mine);
  const mineEdits: Edit[] = sideEdits(baseTokens, mineTokens);
  const theirsTokens: string[] = theirs === mine ? mineTokens : tokenize(theirs);
  const theirsEdits: Edit[] = theirs === mine ? mineEdits : sideEdits(baseTokens, theirsTokens);
  /**
   * The base token index past the spaces at `from`: an edit starting there is adjacent to one ending at `from`.
   */
  const reach = (from: number): number => {
    let at: number = from;
    while (at < baseTokens.length && isInlineSpace(baseTokens[at] ?? '')) {
      at++;
    }

    return at;
  };
  const list: PartList = new PartList();
  let position: number = 0;
  let nextMine: number = 0;
  let nextTheirs: number = 0;

  while (nextMine < mineEdits.length || nextTheirs < theirsEdits.length) {
    // Start a region at the next edit of either side, then pull in every edit whose span overlaps the region's spans or
    // is adjacent to them.
    const firstMine: Edit | undefined = mineEdits[nextMine];
    const firstTheirs: Edit | undefined = theirsEdits[nextTheirs];
    let spanEnd: number = Math.min(firstMine?.spanStart ?? Infinity, firstTheirs?.spanStart ?? Infinity);
    const regionMine: Edit[] = [];
    const regionTheirs: Edit[] = [];
    let grew: boolean = true;
    while (grew) {
      grew = false;
      const mineEdit: Edit | undefined = mineEdits[nextMine];
      if (mineEdit !== undefined && mineEdit.spanStart <= reach(spanEnd)) {
        regionMine.push(mineEdit);
        spanEnd = Math.max(spanEnd, mineEdit.spanEnd);
        nextMine++;
        grew = true;
      }
      const theirsEdit: Edit | undefined = theirsEdits[nextTheirs];
      if (theirsEdit !== undefined && theirsEdit.spanStart <= reach(spanEnd)) {
        regionTheirs.push(theirsEdit);
        spanEnd = Math.max(spanEnd, theirsEdit.spanEnd);
        nextTheirs++;
        grew = true;
      }
    }
    // The spans only decide which changes meet; the region itself is where the diff placed them, so that keeping both
    // sides of a conflict does not repeat the text they could slide over.
    const edits: Edit[] = [...regionMine, ...regionTheirs];
    const start: number = Math.min(...edits.map((edit: Edit): number => edit.start));
    const end: number = Math.max(...edits.map((edit: Edit): number => edit.end));

    list.unchanged(baseTokens.slice(position, start).join(''));
    list.changed(
      baseTokens.slice(start, end).join(''),
      applyEdits(baseTokens, start, end, regionMine),
      applyEdits(baseTokens, start, end, regionTheirs),
    );
    position = end;
  }
  list.unchanged(baseTokens.slice(position).join(''));

  return { parts: list.parts, conflicts: list.conflicts };
};

/**
 * The final text of a merge, with one resolution per conflict, in the order the conflicts appear in `result.parts`.
 * Changes outside the conflicts are kept whatever the resolutions.
 *
 * @throws RangeError if the number of resolutions is not the number of conflicts.
 */
export const resolveMerge = (result: MergeResult, resolutions: readonly ConflictResolution[]): string => {
  if (resolutions.length !== result.conflicts) {
    throw new RangeError(`Expected ${result.conflicts} conflict resolutions, got ${resolutions.length}`);
  }
  let conflict: number = 0;

  return result.parts
    .map((part: MergePart): string => {
      switch (part.kind) {
        case 'unchanged':
          return part.text;
        case 'conflict': {
          const resolution: ConflictResolution | undefined = resolutions[conflict++];
          if (resolution === 'mine') {
            return part.mine;
          }
          if (resolution === 'theirs') {
            return part.theirs;
          }
          if (resolution === 'both') {
            return part.mine + part.theirs;
          }

          return resolution?.edit ?? '';
        }
        default:
          return part.text;
      }
    })
    .join('');
};
