import { useCallback, useEffect, useState } from 'react';

const storageKey = 'reviewr.sidebarOpen';

const readStored = (): boolean => {
  try {
    return window.localStorage.getItem(storageKey) !== 'false';
  } catch {
    return true;
  }
};

/**
 * Whether the document sidebar is unfolded. Remembered across reloads; Ctrl/Cmd + B toggles it.
 */
export const useSidebar = (): [boolean, () => void] => {
  const [open, setOpen] = useState(readStored);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(open));
    } catch {
      // Storage unavailable (private mode…): the choice just won't survive a reload.
    }
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  return [open, toggle];
};
