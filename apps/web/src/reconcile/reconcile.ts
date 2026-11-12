import {
  mergeWords,
  resolveMerge,
  type ChangePart,
  type ConflictPart,
  type ConflictResolution,
  type MergePart,
  type MergeResult,
} from '@reviewr/merge';

/**
 * One conflict of the merge, where it sits in the base, and what the writer chose for it.
 */
export interface ConflictEntry {
  part: ConflictPart;
  /** Offsets of the conflict region in the base: the base is the one thing that never moves between recomputes. */
  start: number;
  end: number;
  resolution?: ConflictResolution;
  /**
   * The other side changed this passage again after the writer resolved it: the earlier choice (or hand edit) is
   * kept, but it does not count as resolved until the writer looks at it again.
   */
  recheck: boolean;
  /** The last text written by hand, kept when the writer switches to another choice, so "Edit by hand" brings it back. */
  draft?: string;
}

/**
 * The state of the reconciliation view, kept out of the component so it can be tested without the DOM.
 */
export interface Reconciliation {
  base: string;
  mine: string;
  theirs: string;
  merge: MergeResult;
  /** One entry per conflict part, in order. */
  conflicts: ConflictEntry[];
  /** Text written by hand for a passage that no longer has a conflict to hold it. Never dropped without the writer. */
  orphans: string[];
  /** Choices (not hand edits, those are orphans) that the last recompute could not carry over. */
  lostChoices: number;
}

const baseLength = (part: MergePart): number => (part.kind === 'unchanged' ? part.text : part.base).length;

const conflictEntries = (merge: MergeResult): ConflictEntry[] => {
  const entries: ConflictEntry[] = [];
  let offset = 0;
  for (const part of merge.parts) {
    const length = baseLength(part);
    if (part.kind === 'conflict') entries.push({ part, start: offset, end: offset + length, recheck: false });
    offset += length;
  }
  return entries;
};

export const createReconciliation = (base: string, mine: string, theirs: string): Reconciliation => {
  const merge = mergeWords(base, mine, theirs);
  return { base, mine, theirs, merge, conflicts: conflictEntries(merge), orphans: [], lostChoices: 0 };
};

/** The text a resolution puts in place of the conflict. */
export const resolutionText = (part: ConflictPart, resolution: ConflictResolution): string => {
  if (resolution === 'mine') return part.mine;
  if (resolution === 'theirs') return part.theirs;
  if (resolution === 'both') return part.mine + part.theirs;
  return resolution.edit;
};

const sameConflict = (a: ConflictEntry, b: ConflictEntry): boolean =>
  a.start === b.start && a.end === b.end && a.part.mine === b.part.mine && a.part.theirs === b.part.theirs;

/** Whether two base regions share text, or touch when one of them is an insertion. */
const overlaps = (a: ConflictEntry, b: ConflictEntry): boolean =>
  a.start === a.end || b.start === b.end ? a.start <= b.end && b.start <= a.end : a.start < b.end && b.start < a.end;

/**
 * Merges again with new texts (in practice, a new `theirs` from the server), keeping what the writer did:
 * - a conflict that is exactly the same keeps its resolution;
 * - a conflict that changed but sits where exactly one resolved conflict was gets that resolution back, flagged to be
 *   checked again;
 * - any other hand edit becomes an orphan, shown to the writer until they dismiss it; any other choice is counted in
 *   `lostChoices`.
 */
export const recompute = (state: Reconciliation, base: string, mine: string, theirs: string): Reconciliation => {
  if (base === state.base && mine === state.mine && theirs === state.theirs) return state;
  const next = createReconciliation(base, mine, theirs);
  // Offsets are only comparable over the same base.
  const comparable = base === state.base;
  const carried = new Set<ConflictEntry>();
  let lostChoices = 0;

  for (const entry of next.conflicts) {
    const exact = comparable ? state.conflicts.find((old) => !carried.has(old) && sameConflict(old, entry)) : undefined;
    if (exact !== undefined) {
      carried.add(exact);
      Object.assign(entry, { resolution: exact.resolution, recheck: exact.recheck, draft: exact.draft });
    }
  }
  for (const entry of next.conflicts) {
    if (entry.resolution !== undefined || !comparable) continue;
    const candidates = state.conflicts.filter(
      (old) => !carried.has(old) && (old.resolution !== undefined || old.draft !== undefined) && overlaps(old, entry),
    );
    const [old] = candidates;
    // An old conflict that also overlaps another new one could go to either: leave it to the orphans below.
    if (old === undefined || candidates.length > 1 || next.conflicts.filter((e) => overlaps(old, e)).length > 1) {
      continue;
    }
    carried.add(old);
    Object.assign(entry, { resolution: old.resolution, recheck: true, draft: old.draft });
  }

  const orphans = [...state.orphans];
  for (const old of state.conflicts) {
    if (carried.has(old)) continue;
    const written = handWritten(old);
    if (written !== undefined) orphans.push(written);
    else if (old.resolution !== undefined) lostChoices++;
  }
  return { ...next, orphans, lostChoices };
};

/** The text the writer typed for a conflict, whether or not it is the current choice. */
export const handWritten = (entry: ConflictEntry): string | undefined =>
  typeof entry.resolution === 'object' ? entry.resolution.edit : entry.draft;

const withConflict = (state: Reconciliation, index: number, entry: ConflictEntry): Reconciliation => ({
  ...state,
  conflicts: state.conflicts.map((old, i) => (i === index ? entry : old)),
});

/** Records the writer's choice for one conflict. Any choice also confirms a passage flagged to be checked again. */
export const resolveConflict = (
  state: Reconciliation,
  index: number,
  resolution: ConflictResolution,
): Reconciliation => {
  const entry = state.conflicts[index];
  if (entry === undefined) return state;
  return withConflict(state, index, { ...entry, resolution, recheck: false, draft: handWritten(entry) });
};

/** The writer checked a passage the other side changed again, and keeps their earlier choice. */
export const keepEarlierChoice = (state: Reconciliation, index: number): Reconciliation => {
  const entry = state.conflicts[index];
  if (entry === undefined) return state;
  return withConflict(state, index, { ...entry, recheck: false });
};

/** The writer has seen (and copied, if they wanted) a hand edit that no longer has a place. */
export const dismissOrphan = (state: Reconciliation, index: number): Reconciliation => ({
  ...state,
  orphans: state.orphans.filter((_, i) => i !== index),
});

export const isResolved = (entry: ConflictEntry): boolean => entry.resolution !== undefined && !entry.recheck;

/** What still blocks the confirmation: conflicts to resolve, and orphaned hand edits to look at. */
export const remaining = (state: Reconciliation): number =>
  state.conflicts.filter((entry) => !isResolved(entry)).length + state.orphans.length;

/** Where the keyboard should go next: an unresolved conflict, an orphan to look at, or Confirm once it is enabled. */
export type FocusTarget = { conflict: number } | { orphan: number } | 'confirm';

/**
 * The next thing that blocks the confirmation, searched after conflict `from` first, then from the start, so a
 * conflict left behind (or marked "Changed again" by a refresh) is never skipped.
 */
export const nextFocus = (state: Reconciliation, from: number): FocusTarget => {
  const open = state.conflicts.flatMap((entry, index) => (isResolved(entry) ? [] : [index]));
  const conflict = open.find((index) => index > from) ?? open[0];
  if (conflict !== undefined) return { conflict };
  if (state.orphans.length > 0) return { orphan: 0 };
  return 'confirm';
};

/** The reconciled text, or `undefined` while something remains to be resolved. */
export const resolvedText = (state: Reconciliation): string | undefined => {
  if (remaining(state) > 0) return undefined;
  return resolveMerge(
    state.merge,
    state.conflicts.map((entry) => entry.resolution as ConflictResolution),
  );
};

/** One run of a paragraph, as the view shows it. */
export type Run =
  { kind: 'text'; text: string } | { kind: 'change'; part: ChangePart } | { kind: 'conflict'; index: number };

/**
 * Splits the merged text into lines at the line breaks of the unchanged text, so the view can keep the prose in reading
 * order and put each conflict's controls after the line that holds it. Joining the runs with `\n` gives the text back.
 */
export const toParagraphs = (merge: MergeResult): Run[][] => {
  const paragraphs: Run[][] = [[]];
  let conflict = 0;
  for (const part of merge.parts) {
    if (part.kind === 'unchanged') {
      part.text.split('\n').forEach((line, i) => {
        if (i > 0) paragraphs.push([]);
        if (line !== '') paragraphs.at(-1)?.push({ kind: 'text', text: line });
      });
    } else if (part.kind === 'conflict') {
      paragraphs.at(-1)?.push({ kind: 'conflict', index: conflict++ });
    } else {
      paragraphs.at(-1)?.push({ kind: 'change', part });
    }
  }
  return paragraphs;
};
