import { ApiError, NetworkError } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTitleSaver } from './title';

const setup = (answer: (title: string | null) => Promise<unknown> = async () => undefined) => {
  const rename = vi.fn(answer);
  const title = createTitleSaver({ initial: null, rename, debounceMs: 800, retryMs: 5000 });
  return { rename, title };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTitleSaver', () => {
  it('renames soon after the writer stops typing, once', async () => {
    const { rename, title } = setup();
    title.edit('A');
    title.edit('A title');
    expect(title.getSnapshot()).toEqual({ value: 'A title', status: 'unsaved' });
    await vi.advanceTimersByTimeAsync(800);
    expect(rename.mock.calls).toEqual([['A title']]);
    expect(title.getSnapshot().status).toBe('saved');
  });

  it('renames at once when the field loses focus, and sends a blank title as untitled', async () => {
    const { rename, title } = setup();
    title.edit('   ');
    title.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(rename.mock.calls).toEqual([[null]]);
  });

  it('sends a failed rename again after a while', async () => {
    let failures = 1;
    const { rename, title } = setup(async () => {
      if (failures-- > 0) throw new NetworkError(new TypeError('offline'));
    });
    title.edit('Offline title');
    await vi.advanceTimersByTimeAsync(800);
    expect(title.getSnapshot().status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(title.getSnapshot().status).toBe('saved');
  });

  it('waits for a change after a refused title', async () => {
    const { rename, title } = setup(async (value) => {
      if (value === 'Refused') throw new ApiError(400, { statusCode: 400, message: 'Invalid title' });
    });
    title.edit('Refused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(title.getSnapshot()).toMatchObject({ value: 'Refused', status: 'refused' });
    title.edit('Accepted');
    await vi.advanceTimersByTimeAsync(800);
    expect(title.getSnapshot().status).toBe('saved');
  });

  it('takes a title read from the server only when no edit is waiting', async () => {
    const { title } = setup();
    title.refresh('From elsewhere');
    expect(title.getSnapshot().value).toBe('From elsewhere');
    title.edit('Mine');
    title.refresh('Again from elsewhere');
    expect(title.getSnapshot().value).toBe('Mine');
  });
});
