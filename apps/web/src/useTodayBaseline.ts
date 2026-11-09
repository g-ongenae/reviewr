import type { Document } from '@reviewr/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, queryKeys } from './api';

const startOfToday = (): number => new Date().setHours(0, 0, 0, 0);

/** Local midnight that started today, in ms; moves on by itself when the next day begins. */
export const useStartOfToday = (): number => {
  const [start, setStart] = useState(startOfToday);
  useEffect(() => {
    const nextMidnight = new Date(start).setDate(new Date(start).getDate() + 1);
    const timer = window.setTimeout(() => setStart(startOfToday()), Math.max(nextMidnight - Date.now(), 0) + 1000);
    return () => window.clearTimeout(timer);
  }, [start]);
  return start;
};

export type TodayBaseline = { status: 'ready'; content: string } | { status: 'loading' } | { status: 'unavailable' };

/**
 * The document's content as it was when today began: the last revision saved before midnight, or nothing for a
 * document created today. What is written today is measured against it, so it adds up across devices and reloads.
 */
export const useTodayBaseline = (document: Document): TodayBaseline => {
  const today = useStartOfToday();
  const createdToday = Date.parse(document.createdAt) >= today;
  const untouchedToday = Date.parse(document.updatedAt) < today;
  const needsHistory = !createdToday && !untouchedToday;

  const revisions = useQuery({
    queryKey: queryKeys.revisions(document.id),
    queryFn: () => api.listRevisions(document.id),
    enabled: needsHistory,
  });
  const lastBeforeToday = revisions.data
    ?.filter((revision) => Date.parse(revision.createdAt) < today)
    .reduce<number | undefined>((latest, { revision }) => Math.max(latest ?? revision, revision), undefined);
  const baseline = useQuery({
    queryKey: queryKeys.revision(document.id, lastBeforeToday ?? 0),
    queryFn: () => api.getRevision(document.id, lastBeforeToday ?? 0),
    enabled: needsHistory && lastBeforeToday !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });

  if (createdToday) return { status: 'ready', content: '' };
  if (untouchedToday) return { status: 'ready', content: document.content };
  if (revisions.data === undefined) return revisions.isError ? { status: 'unavailable' } : { status: 'loading' };
  if (lastBeforeToday === undefined) return { status: 'ready', content: '' };
  if (baseline.data === undefined) return baseline.isError ? { status: 'unavailable' } : { status: 'loading' };
  return { status: 'ready', content: baseline.data.content };
};
