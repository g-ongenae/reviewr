/** The part of a key-value store a stored boolean needs: `expo-sqlite/kv-store`'s `SQLiteStorage` has it. */
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface StoredBoolean {
  /** The value; undefined until the store was read (or could not be), so that nothing shows a guess. */
  get(): boolean | undefined;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A boolean kept in a key-value store, as the web keeps one in `localStorage`. It is undefined until the store is
 * read, then the stored value, or `fallback` when nothing valid is stored or the store cannot be opened or read: a
 * storage failure is never seen by the screen. A value set before the read ends wins over the stored one. Writes are
 * not awaited but run one after the other, so the last value set is the one stored; a failed write is forgotten.
 */
export const storedBoolean = (open: () => Promise<KeyValueStore>, key: string, fallback: boolean): StoredBoolean => {
  let value: boolean | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  // Opened on the next turn: an `open` that throws rejects the promise instead of reaching the caller.
  const store = Promise.resolve().then(open);
  // Unhandled, a rejected `store` would be reported once per write; it is handled once here.
  store.catch(() => undefined);

  void store
    .then((opened) => opened.getItemAsync(key))
    .then(
      (stored) => (stored === 'true' ? true : stored === 'false' ? false : fallback),
      () => fallback,
    )
    .then((read) => {
      if (value !== undefined) return; // Set meanwhile.
      value = read;
      notify();
    });

  let writes: Promise<void> = Promise.resolve();

  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      notify();
      writes = writes
        .then(() => store)
        .then((opened) => opened.setItemAsync(key, String(next)))
        .catch(() => undefined);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
