import type { ApiErrorBody } from './types.js';
import { ApiError } from './api-error.js';
import { NetworkError } from './network-error.js';

const httpBadGateway: number = 502;
const httpServiceUnavailable: number = 503;
const httpGatewayTimeout: number = 504;
const httpInternalServerError: number = 500;

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
