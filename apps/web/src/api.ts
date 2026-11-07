import { ApiError, describeError, isServerUnreachable, ReachabilityTracker, ReviewrClient } from '@reviewr/shared';

export const api = new ReviewrClient(import.meta.env.VITE_API_URL ?? '/api');

/** Whether the API answered the last request; drives the "Server unreachable" notification. */
export const reachability = new ReachabilityTracker();

export const queryKeys = {
  health: ['health'] as const,
  documents: ['documents'] as const,
  document: (id: string) => ['documents', id] as const,
  revisions: (id: string) => ['documents', id, 'revisions'] as const,
  revision: (id: string, revision: number) => ['documents', id, 'revisions', revision] as const,
};

export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/**
 * Message to show next to what failed, or undefined when there is nothing to show there: no error, or the server
 * is unreachable, which the notification already says.
 */
export const inlineError = (error: unknown): string | undefined =>
  error === null || error === undefined || isServerUnreachable(error) ? undefined : describeError(error);
