import { useCallback, useSyncExternalStore } from 'react';

const prefix = '#/documents/';

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

const getSelectedId = (): string | undefined =>
  window.location.hash.startsWith(prefix) ? decodeURIComponent(window.location.hash.slice(prefix.length)) : undefined;

/**
 * Selected document id, kept in the URL hash (`#/documents/<id>`) so it survives reloads and can be bookmarked.
 */
export const useSelectedDocumentId = (): [string | undefined, (id: string | undefined) => void] => {
  const selectedId = useSyncExternalStore(subscribe, getSelectedId);
  const select = useCallback((id: string | undefined) => {
    window.location.hash = id === undefined ? '' : `${prefix}${encodeURIComponent(id)}`;
  }, []);

  return [selectedId, select];
};
