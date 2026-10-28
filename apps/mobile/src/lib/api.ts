import { ApiError, ReviewrClient } from '@reviewr/shared';
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
export const api = new ReviewrClient(apiUrl);

export const queryKeys = {
  documents: ['documents'] as const,
  document: (id: string) => ['documents', id] as const,
  revisions: (id: string) => ['documents', id, 'revisions'] as const,
  revision: (id: string, revision: number) => ['documents', id, 'revisions', revision] as const,
};

export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';
