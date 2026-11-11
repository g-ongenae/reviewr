import type { ApiErrorBody, ConflictBody, DocumentDraft } from './types.js';
import { ApiError } from './api-error.js';
import { NetworkError } from './network-error.js';

const httpBadGateway: number = 502;
const httpServiceUnavailable: number = 503;
const httpGatewayTimeout: number = 504;
const httpInternalServerError: number = 500;
const httpConflict: number = 409;

/**
 * Statuses a gateway (reverse proxy, load balancer) answers with when the API behind it is down or not responding.
 */
const gatewayStatuses: ReadonlySet<number> = new Set([httpBadGateway, httpServiceUnavailable, httpGatewayTimeout]);

/**
 * Whether a request failed because the API could not be reached: no response at all, or a gateway answering in its place.
 */
export const isServerUnreachable = (error: unknown): boolean =>
  error instanceof NetworkError || (error instanceof ApiError && gatewayStatuses.has(error.status));

/**
 * Message the API put in its error body, if it is readable text.
 */
const apiDetail = (body: ApiErrorBody | undefined): string | undefined => {
  const detail: unknown = body?.message;
  if (typeof detail === 'string' && detail.length > 0) {
    return detail;
  }
  if (Array.isArray(detail) && detail.length > 0 && detail.every((part: unknown) => typeof part === 'string')) {
    return detail.join(', ');
  }

  return undefined;
};

/**
 * Message to show the user for a failed request. Never exposes raw HTTP statuses.
 */
export const describeError = (error: unknown): string => {
  if (isServerUnreachable(error)) {
    return 'Server unreachable';
  }
  if (error instanceof ApiError) {
    return (
      apiDetail(error.body) ??
      (error.status >= httpInternalServerError
        ? 'The server ran into a problem. Please try again.'
        : 'The server refused this request.')
    );
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return 'Something went wrong';
};

/** A counter of the API: an integer >= 1. */
const isCounter = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

/**
 * Whether a value has the shape of a `DocumentDraft`.
 */
const isDraft = (value: unknown): value is DocumentDraft => {
  if (typeof value !== 'object' || !value) {
    return false;
  }
  const draft: Partial<Record<keyof DocumentDraft, unknown>> = value;

  return (
    typeof draft.content === 'string' &&
    isCounter(draft.draftVersion) &&
    // eslint-disable-next-line no-null/no-null -- the API sends a missing base revision as JSON null
    (draft.baseRevision === null || isCounter(draft.baseRevision))
  );
};

/**
 * Whether an error body is a well-formed structured 409 body, checked for its own `code`.
 */
const isConflictBody = (body: unknown): body is ConflictBody => {
  if (typeof body !== 'object' || !body) {
    return false;
  }
  const conflict: { code?: unknown; draft?: unknown; revision?: unknown } = body;
  switch (conflict.code) {
    case 'draft_conflict':
      return isDraft(conflict.draft);
    case 'stale_revision':
      return isCounter(conflict.revision);
    default:
      return false;
  }
};

/**
 * Structured body of a 409 Conflict, narrowed by its `code`; undefined for any other error, including
 * a 409 from an API too old to send a code and a body whose payload does not match its code.
 */
export const conflictOf = (error: unknown): ConflictBody | undefined =>
  error instanceof ApiError && error.status === httpConflict && isConflictBody(error.body) ? error.body : undefined;
