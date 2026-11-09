import { useCallback, useEffect, useState } from 'react';

const read = (key: string, fallback: boolean): boolean => {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
};

/** A boolean UI preference remembered across reloads, with a function that flips it. */
export const useStoredBoolean = (key: string, fallback: boolean): [boolean, () => void] => {
  const [value, setValue] = useState(() => read(key, fallback));
  const toggle = useCallback(() => setValue((current) => !current), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // Storage unavailable (private mode…): the choice just won't survive a reload.
    }
  }, [key, value]);

  return [value, toggle];
};
