import { useEffect } from 'react';
import { useStoredBoolean } from './useStoredBoolean';

/**
 * Whether the document sidebar is unfolded. Remembered across reloads; Ctrl/Cmd + B toggles it.
 */
export const useSidebar = (): [boolean, () => void] => {
  const [open, toggle] = useStoredBoolean('reviewr.sidebarOpen', true);

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
