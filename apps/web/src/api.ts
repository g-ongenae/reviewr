import { ApiError, ReviewrClient } from '@reviewr/shared';

export const api = new ReviewrClient(import.meta.env.VITE_API_URL ?? '/api');

export const queryKeys = {
  documents: ['documents'] as const,
  document: (id: string) => ['documents', id] as const,
  revisions: (id: string) => ['documents', id, 'revisions'] as const,
  revision: (id: string, revision: number) => ['documents', id, 'revisions', revision] as const,
};

export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';
