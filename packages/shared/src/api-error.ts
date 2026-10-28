import type { ApiErrorBody } from './types.js';

/**
 * Error thrown by the client when the API answers with a non-2xx status.
 */
export class ApiError extends Error {
  /**
   * @param status - HTTP status code of the response
   * @param body - Parsed error body, when the API sent one
   */
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | undefined,
  ) {
    const detail: string | string[] | undefined = body?.message;
    super(Array.isArray(detail) ? detail.join(', ') : (detail ?? `Request failed with status ${status}`));
    this.name = 'ApiError';
  }
}
