import { MutationCache, QueryClient } from '@tanstack/react-query';
import { reachability } from './api';

/**
 * Query client that reports every request outcome to `reachability`.
 */
export const createQueryClient = (): QueryClient => {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error) => reachability.reportError(error),
      onSuccess: () => reachability.reportSuccess(),
    }),
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  });

  // Report each failed attempt, not just the last retry, so the notification shows up right away.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const { action } = event;
    if (action.type === 'failed' || action.type === 'error') {
      reachability.reportError(action.error);
    } else if (action.type === 'success' && action.manual !== true) {
      reachability.reportSuccess();
    }
  });

  return queryClient;
};
