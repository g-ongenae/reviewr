/** The part of a key-value store a stored boolean needs: `expo-sqlite/kv-store`'s `SQLiteStorage` has it. */
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface StoredBoolean {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A boolean kept in a key-value store, as the web keeps one in `localStorage`. It answers `fallback` until the store
 * is read, and forever if the store cannot be opened or read: a storage failure is never seen by the screen. A value
 * set before the read ends wins over the stored one. Writes are not awaited, and a failed write is forgotten.
 */
export const storedBoolean = (open: () => Promise<KeyValueStore>, key: string, fallback: boolean): StoredBoolean => {
  let value = fallback;
  let setByHand = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  // Opened on the next turn: an `open` that throws rejects the promise instead of reaching the caller.
  const store = Promise.resolve().then(open);
  // Unhandled, a rejected `store` would be reported once per write; it is handled once here.
  store.catch(() => undefined);

  void store
    .then((opened) => opened.getItemAsync(key))
    .then((stored) => {
      if (setByHand || (stored !== 'true' && stored !== 'false')) return;
      value = stored === 'true';
      notify();
    })
    .catch(() => undefined);

  return {
    get: () => value,
    set: (next) => {
      setByHand = true;
      if (next === value) return;
      value = next;
      notify();
      void store.then((opened) => opened.setItemAsync(key, String(next))).catch(() => undefined);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
