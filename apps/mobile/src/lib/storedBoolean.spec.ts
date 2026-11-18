import { describe, expect, it, vi } from 'vitest';
import { type KeyValueStore, storedBoolean } from './storedBoolean';

const memoryStore = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    getItemAsync: vi.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
  };
  return { store, items };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('storedBoolean', () => {
  it('answers the default until the store is read, then the stored value, and tells its listeners', async () => {
    const { store } = memoryStore({ open: 'false' });
    const value = storedBoolean(async () => store, 'open', true);
    const listener = vi.fn();
    value.subscribe(listener);
    expect(value.get()).toBe(true);
    await settle();
    expect(value.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the default when nothing or something else is stored', async () => {
    const { store } = memoryStore({ open: 'maybe' });
    const value = storedBoolean(async () => store, 'open', true);
    await settle();
    expect(value.get()).toBe(true);
    expect(storedBoolean(async () => memoryStore().store, 'open', false).get()).toBe(false);
  });

  it('writes what is set, for the next start', async () => {
    const { store, items } = memoryStore();
    const value = storedBoolean(async () => store, 'open', true);
    value.set(false);
    expect(value.get()).toBe(false);
    await settle();
    expect(items.get('open')).toBe('false');
    const restarted = storedBoolean(async () => store, 'open', true);
    await settle();
    expect(restarted.get()).toBe(false);
  });

  it('lets a value set before the read ends win over the stored one', async () => {
    const { store } = memoryStore({ open: 'true' });
    const value = storedBoolean(async () => store, 'open', true);
    value.set(false);
    await settle();
    expect(value.get()).toBe(false);
  });

  it('never throws when the store cannot be opened, read or written: it keeps working in memory', async () => {
    const throwing = storedBoolean(
      () => {
        throw new Error('no native module');
      },
      'open',
      true,
    );
    const rejecting = storedBoolean(async () => Promise.reject(new Error('disk full')), 'open', true);
    const broken: KeyValueStore = {
      getItemAsync: async () => Promise.reject(new Error('locked')),
      setItemAsync: async () => Promise.reject(new Error('locked')),
    };
    const failing = storedBoolean(async () => broken, 'open', true);
    for (const value of [throwing, rejecting, failing]) {
      value.set(false);
      await settle();
      expect(value.get()).toBe(false);
    }
  });
});
