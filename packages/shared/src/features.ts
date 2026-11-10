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
 * Wrap a fetch implementation so every request announces {@link clientFeatures}. Pass the result to
 * `ReviewrClient` in the apps.
 */
export const withClientFeatures =
  (fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch =>
  async (input, init) => {
    const headers: Headers = new Headers(init?.headers);
    headers.set(clientFeaturesHeader, clientFeatures.join(','));

    return fetchFn(input, { ...init, headers });
  };
