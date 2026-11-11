import { describe, expect, it, vi } from 'vitest';
import { ReviewrClient } from './client.js';
import { clientFeaturesHeader, withClientFeatures } from './features.js';

describe('withClientFeatures', () => {
  it('announces the features on every request and keeps the other headers', async () => {
    const fetchFn = vi.fn(
      async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new ReviewrClient('http://api.test', withClientFeatures(fetchFn));

    await client.listDocuments();
    await client.createDocument({ content: 'x' });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) {
      const headers = new Headers(init.headers);
      expect(headers.get(clientFeaturesHeader)).toBe('nullable-title');
      expect(headers.get('Accept')).toBe('application/json');
    }
    const [, createInit] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    expect(createInit).toMatchObject({ method: 'POST', body: '{"content":"x"}' });
    expect(new Headers(createInit.headers).get('Content-Type')).toBe('application/json');
  });

  it('keeps the headers of a Request input', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    const request = new Request('http://api.test/documents', { headers: { Authorization: 'Bearer token' } });

    await withClientFeatures(fetchFn)(request);
    await withClientFeatures(fetchFn)(request, { headers: { Accept: 'text/plain' } });

    const [, kept] = fetchFn.mock.calls[0] as unknown as [Request, RequestInit];
    const [, replaced] = fetchFn.mock.calls[1] as unknown as [Request, RequestInit];
    expect(new Headers(kept.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(kept.headers).get(clientFeaturesHeader)).toBe('nullable-title');
    // Headers given in init replace the ones of the Request, as in fetch.
    expect(new Headers(replaced.headers).get('Authorization')).toBeNull();
    expect(new Headers(replaced.headers).get('Accept')).toBe('text/plain');
    expect(new Headers(replaced.headers).get(clientFeaturesHeader)).toBe('nullable-title');
  });
});
