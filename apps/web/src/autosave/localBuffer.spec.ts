import { forceCloseDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localBufferSchema, openLocalBuffer, type LocalBuffer, type LocalBufferOptions } from './localBuffer';

const NAME = 'reviewr-test';

/** Opens the database without the module, as another tab or a later version of the code would. */
const rawOpen = (factory: IDBFactory, version: number, upgrade?: (db: IDBDatabase) => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });

const addOutbox = (db: IDBDatabase) => {
  db.createObjectStore('outbox', { autoIncrement: true });
};

describe('openLocalBuffer', () => {
  let factory: IDBFactory;
  let clock: number;
  const buffers: LocalBuffer[] = [];

  const open = (options: LocalBufferOptions = {}) => {
    const buffer = openLocalBuffer({ indexedDB: factory, name: NAME, now: () => ++clock, ...options });
    buffers.push(buffer);
    return buffer;
  };

  beforeEach(() => {
    factory = new IDBFactory();
    clock = 1000;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(buffers.splice(0).map((buffer) => buffer.close()));
  });

  it('stores the text and its base, and answers "nothing stored" for an unknown key', async () => {
    const buffer = open();

    expect(await buffer.get('doc-1')).toEqual({ ok: true, entry: undefined });
    expect(await buffer.put('doc-1', { content: 'Once upon', base: { content: 'Once', draftVersion: 3 } })).toEqual({
      ok: true,
    });
    expect(await buffer.put('new:abc', { content: 'A new text', base: null })).toEqual({ ok: true });

    expect(await buffer.get('doc-1')).toEqual({
      ok: true,
      entry: { key: 'doc-1', content: 'Once upon', base: { content: 'Once', draftVersion: 3 }, updatedAt: 1001 },
    });
    expect(await buffer.get('new:abc')).toEqual({
      ok: true,
      entry: { key: 'new:abc', content: 'A new text', base: null, updatedAt: 1002 },
    });
  });

  it('lists every entry, the most recently written first', async () => {
    const buffer = open();
    await buffer.put('a', { content: 'A', base: null });
    await buffer.put('b', { content: 'B', base: { content: '', draftVersion: 1 } });
    await buffer.put('a', { content: 'A2', base: null });

    const result = await buffer.list();

    expect(result.ok).toBe(true);
    expect(result.entries.map(({ key, content }) => [key, content])).toEqual([
      ['a', 'A2'],
      ['b', 'B'],
    ]);
  });

  describe('call order', () => {
    it('keeps the last put when puts overlap', async () => {
      const buffer = open();

      const writes = ['O', 'On', 'Onc', 'Once'].map((content) => buffer.put('doc', { content, base: null }));
      const read = buffer.get('doc');

      expect(await Promise.all(writes)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
      expect((await read).entry?.content).toBe('Once');
      expect((await buffer.get('doc')).entry?.content).toBe('Once');
    });

    it('never lets a delete remove text put after it', async () => {
      const buffer = open();
      await buffer.put('doc', { content: 'Once', base: null });

      const removed = buffer.delete('doc');
      const written = buffer.put('doc', { content: 'Once upon', base: null });

      expect(await removed).toEqual({ ok: true, deleted: true });
      expect(await written).toEqual({ ok: true });
      expect((await buffer.get('doc')).entry?.content).toBe('Once upon');
    });

    it('applies a put made before a delete', async () => {
      const buffer = open();

      void buffer.put('doc', { content: 'Once', base: null });
      const removed = buffer.delete('doc');

      expect(await removed).toEqual({ ok: true, deleted: true });
      expect(await buffer.get('doc')).toEqual({ ok: true, entry: undefined });
    });
  });

  describe('conditional delete', () => {
    it('keeps text typed while the save was in flight', async () => {
      const buffer = open();
      await buffer.put('doc', { content: 'Once', base: { content: '', draftVersion: 1 } });
      // The autosave sends "Once"; the writer keeps typing before the server answers.
      await buffer.put('doc', { content: 'Once upon', base: { content: '', draftVersion: 1 } });

      // The server confirmed "Once".
      expect(await buffer.delete('doc', { ifContent: 'Once' })).toEqual({ ok: true, deleted: false });
      expect((await buffer.get('doc')).entry?.content).toBe('Once upon');
    });

    it('deletes when the stored text is the confirmed one', async () => {
      const buffer = open();
      await buffer.put('doc', { content: 'Once upon', base: null });

      expect(await buffer.delete('doc', { ifContent: 'Once upon' })).toEqual({ ok: true, deleted: true });
      expect(await buffer.get('doc')).toEqual({ ok: true, entry: undefined });
    });

    it('checks the condition against the latest put, even when calls overlap', async () => {
      const buffer = open();

      void buffer.put('doc', { content: 'Once', base: null });
      void buffer.put('doc', { content: 'Once upon', base: null });
      const removed = buffer.delete('doc', { ifContent: 'Once' });

      expect(await removed).toEqual({ ok: true, deleted: false });
      expect((await buffer.get('doc')).entry?.content).toBe('Once upon');
    });

    it('reports that there was nothing to delete', async () => {
      const buffer = open();

      expect(await buffer.delete('doc')).toEqual({ ok: true, deleted: false });
      expect(await buffer.delete('doc', { ifContent: '' })).toEqual({ ok: true, deleted: false });
    });
  });

  describe('persistence', () => {
    it('keeps the text when the database is closed and opened again', async () => {
      const first = open();
      await first.put('doc', { content: 'Once upon a time', base: { content: 'Once', draftVersion: 2 } });
      await first.close();

      const second = open();

      expect((await second.get('doc')).entry).toEqual({
        key: 'doc',
        content: 'Once upon a time',
        base: { content: 'Once', draftVersion: 2 },
        updatedAt: 1001,
      });
    });

    it('finishes the calls made before close, and refuses the ones made after', async () => {
      const buffer = open();
      const written = buffer.put('doc', { content: 'Once', base: null });
      const closing = buffer.close();

      expect(await buffer.get('doc')).toMatchObject({ ok: false, reason: 'unavailable', entry: undefined });
      expect(await written).toEqual({ ok: true });
      await closing;
      expect((await open().get('doc')).entry?.content).toBe('Once');
    });

    it('reads back a stored record with a malformed base as having no base', async () => {
      const db = await rawOpen(factory, localBufferSchema.length, (db) => localBufferSchema[0]?.(db, undefined!));
      await new Promise<void>((resolve) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ key: 'doc', content: 'Kept', base: { draftVersion: 'x' } });
        tx.oncomplete = () => resolve();
      });
      db.close();

      expect((await open().get('doc')).entry).toEqual({ key: 'doc', content: 'Kept', base: null, updatedAt: 0 });
    });
  });

  describe('schema upgrades', () => {
    const v2 = [...localBufferSchema, addOutbox];

    it('keeps buffered text when a later version adds a store', async () => {
      const v1 = open();
      await v1.put('doc', { content: 'Once upon', base: { content: 'Once', draftVersion: 1 } });
      await v1.close();

      const upgraded = open({ schema: v2 });

      expect((await upgraded.get('doc')).entry?.content).toBe('Once upon');
      await upgraded.close();
      const db = await rawOpen(factory, v2.length);
      expect([...db.objectStoreNames].sort()).toEqual(['drafts', 'outbox']);
      db.close();
    });

    it('runs every step on a new database', async () => {
      const buffer = open({ schema: v2 });

      expect(await buffer.put('doc', { content: 'Once', base: null })).toEqual({ ok: true });
      await buffer.close();
      const db = await rawOpen(factory, v2.length);
      expect([...db.objectStoreNames].sort()).toEqual(['drafts', 'outbox']);
      db.close();
    });

    it('leaves the data untouched when a step fails', async () => {
      const v1 = open();
      await v1.put('doc', { content: 'Once', base: null });
      await v1.close();

      const broken = open({
        schema: [
          ...localBufferSchema,
          () => {
            throw new Error('bad migration');
          },
        ],
      });

      expect(await broken.get('doc')).toMatchObject({ ok: false, reason: 'failed', entry: undefined });
      expect((await open().get('doc')).entry?.content).toBe('Once');
    });

    it('steps aside when another tab upgrades, and reports the newer database as failed', async () => {
      const buffer = open();
      await buffer.put('doc', { content: 'Once', base: null });

      // Another tab runs a newer build: it is not blocked by this connection.
      const newer = await rawOpen(factory, v2.length, addOutbox);
      newer.close();

      expect(await buffer.get('doc')).toMatchObject({ ok: false, reason: 'failed', entry: undefined });
      expect((await open({ schema: v2 }).get('doc')).entry?.content).toBe('Once');
    });

    it('reports an upgrade blocked by another tab, and tries again on the next call', async () => {
      const v1 = open();
      await v1.put('doc', { content: 'Once', base: null });
      await v1.close();
      // An old tab that does not close its connection when asked to.
      const old = await rawOpen(factory, localBufferSchema.length);
      old.onversionchange = () => {};

      const upgraded = open({ schema: v2 });

      expect(await upgraded.get('doc')).toMatchObject({ ok: false, reason: 'blocked', entry: undefined });
      old.close();
      expect((await upgraded.get('doc')).entry?.content).toBe('Once');
    });
  });

  describe('when IndexedDB is not usable', () => {
    const expectUnusable = async (buffer: LocalBuffer, reason: string) => {
      expect(await buffer.put('doc', { content: 'Once', base: null })).toMatchObject({ ok: false, reason });
      expect(await buffer.get('doc')).toMatchObject({ ok: false, reason, entry: undefined });
      expect(await buffer.list()).toMatchObject({ ok: false, reason, entries: [] });
      expect(await buffer.delete('doc')).toMatchObject({ ok: false, reason, deleted: false });
    };

    it('answers "unavailable" when there is no IndexedDB', async () => {
      await expectUnusable(open({ indexedDB: null }), 'unavailable');
    });

    it('answers "unavailable" when opening throws (private mode)', async () => {
      vi.spyOn(factory, 'open').mockImplementation(() => {
        throw new DOMException(
          'A mutation operation was attempted on a database that did not allow mutations.',
          'InvalidStateError',
        );
      });

      await expectUnusable(open(), 'unavailable');
    });

    it('answers "unavailable" when the open request fails', async () => {
      vi.spyOn(factory, 'open').mockImplementation(() => {
        const request = { error: new DOMException('denied', 'UnknownError') } as unknown as IDBOpenDBRequest;
        setTimeout(() => {
          request.onerror?.(new Event('error'));
        });
        return request;
      });

      await expectUnusable(open(), 'unavailable');
    });

    it('answers "unavailable" when opening never answers (old browsers)', async () => {
      vi.spyOn(factory, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);

      await expectUnusable(open({ openTimeoutMs: 10 }), 'unavailable');
    });

    it('answers "quota" when the storage is full, and keeps what was stored', async () => {
      const buffer = open();
      await buffer.put('doc', { content: 'Once', base: null });
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      });

      expect(await buffer.put('doc', { content: 'Once upon', base: null })).toMatchObject({
        ok: false,
        reason: 'quota',
      });
      expect((await buffer.get('doc')).entry?.content).toBe('Once');
    });

    it('answers "failed" when a transaction aborts', async () => {
      const buffer = open();
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore) {
        this.transaction.abort();
        return {} as IDBRequest<IDBValidKey>;
      });

      expect(await buffer.put('doc', { content: 'Once', base: null })).toMatchObject({ ok: false, reason: 'failed' });
      expect(await buffer.get('doc')).toEqual({ ok: true, entry: undefined });
    });

    it('opens again after the browser closed the connection (storage cleared)', async () => {
      const opened = vi.spyOn(factory, 'open');
      const buffer = open();
      await buffer.put('doc', { content: 'Once', base: null });
      const db = (opened.mock.results[0]?.value as IDBOpenDBRequest).result;

      // Its typings ask for the class, but it takes a connection.
      (forceCloseDatabase as unknown as (db: IDBDatabase) => void)(db);

      expect((await buffer.get('doc')).entry?.content).toBe('Once');
      expect(opened).toHaveBeenCalledTimes(2);
    });
  });
});
