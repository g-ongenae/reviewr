import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { deviceBufferFailure, subscribeDeviceBufferFailure } from '../autosave/deviceBuffer';

/**
 * Tells the writer, once, that this device is not keeping a local copy of the text (the browser has no storage, it is
 * full, or it stopped answering). Nothing else changes: typing goes on, and the text keeps being saved to the server.
 */
export const LocalCopyNotice = () => {
  const queryClient = useQueryClient();
  const failure = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDeviceBufferFailure(queryClient, listener), [queryClient]),
    () => deviceBufferFailure(queryClient),
  );
  const [dismissed, setDismissed] = useState(false);
  if (failure === undefined || dismissed) return null;
  return (
    <div className="toast toast-dismissible">
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
        {/* "hard-drive" from Lucide (ISC licence). */}
        <line x1="22" x2="2" y1="12" y2="12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        <line x1="6" x2="6.01" y1="16" y2="16" />
        <line x1="10" x2="10.01" y1="16" y2="16" />
      </svg>
      <div className="toast-text">
        <strong>No copy kept on this device</strong>
        <span>
          {failure === 'quota' ? 'The browser’s storage is full. ' : ''}Your text is still saved to the server as you
          write, but a crash could lose what it has not received yet.
        </span>
      </div>
      <button type="button" className="toast-dismiss" onClick={() => setDismissed(true)}>
        OK
      </button>
    </div>
  );
};
