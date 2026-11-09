import { isServerUnreachable } from '@reviewr/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { api, queryKeys, reachability } from '../api';

interface Props {
  /** How often to check whether the server is back, in milliseconds. */
  probeInterval?: number;
}

/**
 * Shows a single "Server unreachable" notification while the API can't be reached, checks in the background whether
 * it is back, then reloads whatever failed in the meantime.
 */
export const ServerStatus = ({ probeInterval = 5000 }: Props) => {
  const queryClient = useQueryClient();
  const unreachable = useSyncExternalStore(reachability.subscribe, reachability.isUnreachable);

  useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    enabled: unreachable,
    refetchInterval: probeInterval,
    retry: false,
  });

  useEffect(() => {
    if (!unreachable) {
      void queryClient.invalidateQueries({ predicate: (query) => isServerUnreachable(query.state.error) });
    }
  }, [unreachable, queryClient]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {unreachable && (
        <div className="toast">
          <svg
            className="toast-icon"
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* "cloud-off" from Lucide (ISC licence). */}
            <path d="m2 2 20 20" />
            <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" />
            <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />
          </svg>
          <div className="toast-text">
            <strong>Server unreachable</strong>
            <span>Keep writing, we’ll reconnect on our own.</span>
          </div>
        </div>
      )}
    </div>
  );
};
