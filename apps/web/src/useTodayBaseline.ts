import type { Baseline, Document } from '@reviewr/shared';
import {
  lastRevisionBaseline,
  lastRevisionBefore,
  previousRevisionOf,
  startOfDay,
  startOfNextDay,
  todayBaseline,
  todayNeedsHistory,
} from '@reviewr/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, queryKeys } from './api';

/** Local midnight that started today, in ms; moves on by itself when the next day begins. */
export const useStartOfToday = (): number => {
  const [start, setStart] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    const delay = Math.max(startOfNextDay(start) - Date.now(), 0) + 1000;
    const timer = window.setTimeout(() => setStart(startOfDay(Date.now())), delay);
    return () => window.clearTimeout(timer);
  }, [start]);
  return start;
};

/** The document's content as it was when today began (see `todayBaseline`). */
export const useTodayBaseline = (document: Document): Baseline => {
  const today = useStartOfToday();
  const needsHistory = todayNeedsHistory(document, today);

  const revisions = useQuery({
    queryKey: queryKeys.revisions(document.id),
    queryFn: () => api.listRevisions(document.id),
    enabled: needsHistory,
  });
  const lastBeforeToday = lastRevisionBefore(revisions.data, today);
  const baseline = useQuery({
    queryKey: queryKeys.revision(document.id, lastBeforeToday ?? 0),
    queryFn: () => api.getRevision(document.id, lastBeforeToday ?? 0),
    enabled: needsHistory && lastBeforeToday !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });
  return todayBaseline(document, today, revisions, baseline);
};

/** The content of the revision before the saved one: what the last save changed. Nothing before the first revision. */
export const useLastRevisionBaseline = (document: Document): Baseline => {
  const previous = previousRevisionOf(document);
  const query = useQuery({
    queryKey: queryKeys.revision(document.id, previous),
    queryFn: () => api.getRevision(document.id, previous),
    enabled: previous > 0,
    staleTime: Infinity, // Revisions are immutable.
  });
  return lastRevisionBaseline(document, query);
};
