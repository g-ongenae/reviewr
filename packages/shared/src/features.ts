/**
 * Request header through which a client lists the API features it understands, comma-separated. The API keeps
 * the older response format for a client that does not announce a feature, so installed builds keep working.
 */
export const clientFeaturesHeader: string = 'X-Reviewr-Features';

/**
 * Feature: the client understands `title: null` for an untitled document. Without it, the API answers `''`.
 */
export const nullableTitleFeature: string = 'nullable-title';

/** Features this version of the shared client understands. */
export const clientFeatures: readonly string[] = [nullableTitleFeature];

/**
 * Headers the call would send: those of `init`, or those of a `Request` input when `init` gives none (headers
 * given in `init` replace the ones of the `Request`, as in `fetch`).
 */
const headersOf = (input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Headers => {
  if (init?.headers === undefined && typeof Request !== 'undefined' && input instanceof Request) {
    return new Headers(input.headers);
  }

  return new Headers(init?.headers);
};

/**
 * Wrap a fetch implementation so every request announces {@link clientFeatures}. Pass the result to
 * `ReviewrClient` in the apps.
 */
export const withClientFeatures =
  (fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch =>
  async (input, init) => {
    const headers: Headers = headersOf(input, init);
    headers.set(clientFeaturesHeader, clientFeatures.join(','));

    return fetchFn(input, { ...init, headers });
  };
