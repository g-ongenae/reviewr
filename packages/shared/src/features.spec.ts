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
});
