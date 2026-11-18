import type { Document, RevisionSummary } from './types.js';

/**
 * Which past versions the writing stats measure the text against. The apps read the revisions with their own queries;
 * these functions decide which ones to read and what the stats show meanwhile, so both apps count from the same text.
 */

/** A past version of the text, which may still be loading or out of reach while the server is. */
export type Baseline = { status: 'ready'; content: string } | { status: 'loading' } | { status: 'unavailable' };

/** What a read of the server gave so far: its data once it came, and whether it failed. */
export interface BaselineRead<T> {
  data: T | undefined;
  isError: boolean;
}

/** Local midnight that started the day of `now`, in ms. */
export const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

/** Local midnight that starts the day after the one started at `start`, in ms. */
export const startOfNextDay = (start: number): number => {
  const next = new Date(start);
  next.setDate(next.getDate() + 1);

  return next.getTime();
};

/** Whether "today" needs the history: the document was created before today and saved today. */
export const todayNeedsHistory = (document: Pick<Document, 'createdAt' | 'updatedAt'>, today: number): boolean =>
  Date.parse(document.createdAt) < today && Date.parse(document.updatedAt) >= today;

/** The last revision saved before `today`, or undefined when there is none (or the list is not read yet). */
export const lastRevisionBefore = (
  revisions: readonly Pick<RevisionSummary, 'revision' | 'createdAt'>[] | undefined,
  today: number,
): number | undefined =>
  revisions
    ?.filter((revision) => Date.parse(revision.createdAt) < today)
    .reduce<number | undefined>((latest, { revision }) => Math.max(latest ?? revision, revision), undefined);

/** What a read gave: the text once it came, "unavailable" when it failed, "loading" meanwhile. */
const fromRead = (read: BaselineRead<{ content: string }>): Baseline => {
  if (read.data !== undefined) {
    return { status: 'ready', content: read.data.content };
  }

  return read.isError ? { status: 'unavailable' } : { status: 'loading' };
};

/**
 * The document's content as it was when today began: the last revision saved before midnight, or nothing for a
 * document created today. What is written today is measured against it, so it adds up across devices and reloads.
 * `revisions` and `revision` are the reads of the history and of that revision (unused when the history is not needed).
 */
export const todayBaseline = (
  document: Pick<Document, 'content' | 'createdAt' | 'updatedAt'>,
  today: number,
  revisions: BaselineRead<readonly Pick<RevisionSummary, 'revision' | 'createdAt'>[]>,
  revision: BaselineRead<{ content: string }>,
): Baseline => {
  if (Date.parse(document.createdAt) >= today) {
    return { status: 'ready', content: '' };
  }
  if (Date.parse(document.updatedAt) < today) {
    return { status: 'ready', content: document.content };
  }
  if (revisions.data === undefined) {
    return revisions.isError ? { status: 'unavailable' } : { status: 'loading' };
  }
  if (lastRevisionBefore(revisions.data, today) === undefined) {
    return { status: 'ready', content: '' };
  }

  return fromRead(revision);
};

/** The revision before the saved one, whose content shows what the last save changed; 0 when there is none. */
export const previousRevisionOf = (document: Pick<Document, 'revision'>): number => Math.max(document.revision - 1, 0);

/** The content of the revision before the saved one: what the last save changed. Nothing before the first revision. */
export const lastRevisionBaseline = (
  document: Pick<Document, 'revision'>,
  revision: BaselineRead<{ content: string }>,
): Baseline => (previousRevisionOf(document) === 0 ? { status: 'ready', content: '' } : fromRead(revision));
