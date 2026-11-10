import {
  ApiError,
  describeError,
  isServerUnreachable,
  ReachabilityTracker,
  ReviewrClient,
  withClientFeatures,
} from '@reviewr/shared';
import Constants from 'expo-constants';

/**
 * API URL: EXPO_PUBLIC_API_URL if set, otherwise port 3000 on the host running the Expo dev server.
 */
const resolveApiUrl = (): string => {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const devServerHost = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${devServerHost ?? '10.0.2.2'}:3000`;
};

export const apiUrl = resolveApiUrl();
// Announces that this app understands absent titles (`title: null`); see `withClientFeatures`.
export const api = new ReviewrClient(apiUrl, withClientFeatures());

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

/**
 * Message to show next to what failed, or undefined when there is nothing to show there: no error, or the server
 * is unreachable, which the notification already says.
 */
export const inlineError = (error: unknown): string | undefined =>
  error === null || error === undefined || isServerUnreachable(error) ? undefined : describeError(error);
