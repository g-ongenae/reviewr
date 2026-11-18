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
const useStartOfToday = (): number => {
  const [start, setStart] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    const delay = Math.max(startOfNextDay(start) - Date.now(), 0) + 1000;
    const timer = setTimeout(() => setStart(startOfDay(Date.now())), delay);
    return () => clearTimeout(timer);
  }, [start]);
  return start;
};

/**
 * What the writing stats measure the text against, read as the history screen reads revisions: the phone's `api` and
 * query keys, so a revision read here is not read again there. See `todayBaseline` and `lastRevisionBaseline`.
 */
export const useWritingBaselines = (document: Document): { today: Baseline; lastRevision: Baseline } => {
  const today = useStartOfToday();
  const needsHistory = todayNeedsHistory(document, today);
  const revisions = useQuery({
    queryKey: queryKeys.revisions(document.id),
    queryFn: () => api.listRevisions(document.id),
    enabled: needsHistory,
  });
  const lastBeforeToday = lastRevisionBefore(revisions.data, today);
  const todayRevision = useQuery({
    queryKey: queryKeys.revision(document.id, lastBeforeToday ?? 0),
    queryFn: () => api.getRevision(document.id, lastBeforeToday ?? 0),
    enabled: needsHistory && lastBeforeToday !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });

  const previous = previousRevisionOf(document);
  const previousRevision = useQuery({
    queryKey: queryKeys.revision(document.id, previous),
    queryFn: () => api.getRevision(document.id, previous),
    enabled: previous > 0,
    staleTime: Infinity,
  });

  return {
    today: todayBaseline(document, today, revisions, todayRevision),
    lastRevision: lastRevisionBaseline(document, previousRevision),
  };
};
