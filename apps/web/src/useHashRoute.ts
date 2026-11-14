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
 * With `replace`, the address changes without a new entry in the history (the blank page becoming its document).
 */
export const useSelectedDocumentId = (): [string | undefined, (id: string | undefined, replace?: boolean) => void] => {
  const selectedId = useSyncExternalStore(subscribe, getSelectedId);
  const select = useCallback((id: string | undefined, replace = false) => {
    const hash = id === undefined ? '' : `${prefix}${encodeURIComponent(id)}`;
    if (replace) window.location.replace(`#${hash.replace(/^#/, '')}`);
    else window.location.hash = hash;
  }, []);

  return [selectedId, select];
};
