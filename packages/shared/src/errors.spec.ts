import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error.js';
import { ReviewrClient } from './client.js';
import { describeError, isServerUnreachable } from './errors.js';
import { NetworkError } from './network-error.js';
import { ReachabilityTracker } from './reachability.js';

/**
 * Client whose fetch answers with the given response, or fails with the given error.
 */
const clientAnswering = (answer: Response | Error): ReviewrClient =>
  new ReviewrClient(
    'http://api.test',
    vi.fn(async () => (answer instanceof Error ? Promise.reject(answer) : answer)),
  );

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ReviewrClient errors', () => {
  it('throws a NetworkError when no response comes back', async () => {
    const error: unknown = await clientAnswering(new TypeError('Failed to fetch'))
      .listDocuments()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
  });

  it('lets aborted requests through untouched', async () => {
    const abort: DOMException = new DOMException('The operation was aborted.', 'AbortError');
    await expect(clientAnswering(abort).listDocuments()).rejects.toBe(abort);
  });

  it('throws an ApiError carrying the status of a gateway page that is not JSON', async () => {
    const error: unknown = await clientAnswering(new Response('<html>Bad Gateway</html>', { status: 502 }))
      .listDocuments()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).body).toBeUndefined();
  });
});

describe('isServerUnreachable', () => {
  it.each([
    ['a network failure', new NetworkError(new TypeError('Failed to fetch'))],
    ['a 502 Bad Gateway', new ApiError(502, undefined)],
    ['a 503 Service Unavailable', new ApiError(503, { statusCode: 503, message: 'Database unreachable' })],
    ['a 504 Gateway Timeout', new ApiError(504, undefined)],
  ])('is true for %s', (_label: string, error: Error) => {
    expect(isServerUnreachable(error)).toBe(true);
  });

  it.each([
    ['a 500 from the API', new ApiError(500, { statusCode: 500, message: 'Internal server error' })],
    ['a 404', new ApiError(404, undefined)],
    ['a 409 conflict', new ApiError(409, undefined)],
    ['an unrelated error', new Error('boom')],
    ['a non-error value', 'boom'],
  ])('is false for %s', (_label: string, error: unknown) => {
    expect(isServerUnreachable(error)).toBe(false);
  });
});

describe('describeError', () => {
  it('says the server is unreachable for network and gateway errors', () => {
    expect(describeError(new NetworkError(new TypeError('Failed to fetch')))).toBe('Server unreachable');
    expect(describeError(new ApiError(502, undefined))).toBe('Server unreachable');
  });

  it('uses the message sent by the API', () => {
    expect(describeError(new ApiError(404, { statusCode: 404, message: 'Document not found' }))).toBe(
      'Document not found',
    );
    expect(
      describeError(new ApiError(400, { statusCode: 400, message: ['title is too long', 'content is required'] })),
    ).toBe('title is too long, content is required');
  });

  it('never shows a raw HTTP status', () => {
    const server: string = describeError(new ApiError(500, undefined));
    const client: string = describeError(new ApiError(400, undefined));

    expect(server).toBe('The server ran into a problem. Please try again.');
    expect(client).toBe('The server refused this request.');
    expect(`${server} ${client}`).not.toMatch(/status|\d{3}/);
  });

  it('ignores error bodies that are not readable text', () => {
    const body: unknown = { statusCode: 500, message: { nested: true } };
    expect(describeError(new ApiError(500, body as never))).toBe('The server ran into a problem. Please try again.');
  });

  it('falls back to the error message, then to a generic one', () => {
    expect(describeError(new Error('Nothing to restore'))).toBe('Nothing to restore');
    expect(describeError(undefined)).toBe('Something went wrong');
  });
});

describe('ReachabilityTracker', () => {
  it('flags the server once, however many requests fail, and clears on the next success', () => {
    const tracker: ReachabilityTracker = new ReachabilityTracker();
    const listener: () => void = vi.fn();
    tracker.subscribe(listener);

    tracker.reportError(new ApiError(502, undefined));
    tracker.reportError(new NetworkError(new TypeError('Failed to fetch')));
    expect(tracker.isUnreachable()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    tracker.reportSuccess();
    expect(tracker.isUnreachable()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('treats an error answered by the API itself as proof it is reachable', () => {
    const tracker: ReachabilityTracker = new ReachabilityTracker();
    tracker.reportError(new NetworkError(new TypeError('Failed to fetch')));

    tracker.reportError(new Error('not an HTTP error'));
    expect(tracker.isUnreachable()).toBe(true);

    tracker.reportError(new ApiError(404, undefined));
    expect(tracker.isUnreachable()).toBe(false);
  });

  it('stops notifying after unsubscribing', () => {
    const tracker: ReachabilityTracker = new ReachabilityTracker();
    const listener: () => void = vi.fn();
    const unsubscribe: () => void = tracker.subscribe(listener);

    unsubscribe();
    tracker.reportError(new ApiError(503, undefined));
    expect(listener).not.toHaveBeenCalled();
  });
});
