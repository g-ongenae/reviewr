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
  it('is unknown until the store is read, then the stored value, and tells its listeners', async () => {
    const { store } = memoryStore({ open: 'false' });
    const value = storedBoolean(async () => store, 'open', true);
    const listener = vi.fn();
    value.subscribe(listener);
    // Never the default first: a stored "false" must not show the panel for a moment.
    expect(value.get()).toBeUndefined();
    await settle();
    expect(value.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('becomes the default when nothing or something else is stored', async () => {
    const nothing = storedBoolean(async () => memoryStore().store, 'open', true);
    const garbage = storedBoolean(async () => memoryStore({ open: 'maybe' }).store, 'open', false);
    await settle();
    expect(nothing.get()).toBe(true);
    expect(garbage.get()).toBe(false);
  });

  it('writes what is set, for the next start', async () => {
    const { store, items } = memoryStore();
    const value = storedBoolean(async () => store, 'open', true);
    await settle();
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
    expect(value.get()).toBe(false);
    await settle();
    expect(value.get()).toBe(false);
  });

  it('stores the last value set, even when an earlier write is slower', async () => {
    const items = new Map<string, string>();
    const delays = [30, 0];
    const store: KeyValueStore = {
      getItemAsync: async () => null,
      setItemAsync: async (key, stored) => {
        await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
        items.set(key, stored);
      },
    };
    const value = storedBoolean(async () => store, 'open', true);
    await settle();
    value.set(false); // Its write takes 30 ms.
    value.set(true); // Its write is instant, but must land after the first one.
    expect(value.get()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(items.get('open')).toBe('true');
  });

  it('never throws when the store cannot be opened, read or written: it falls back, then keeps working in memory', async () => {
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
    await settle();
    for (const value of [throwing, rejecting, failing]) {
      expect(value.get()).toBe(true);
      value.set(false);
      await settle();
      expect(value.get()).toBe(false);
    }
  });
});
