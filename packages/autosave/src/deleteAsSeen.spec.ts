import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutosave, type Autosave, type Draft, type SaveResult } from './autosave.js';
import { captureDelete, DeleteRefused, deleteAsSeen, type DeleteCapture } from './deleteAsSeen.js';

/** A server holding one document, with the API's rules for drafts and for a delete that carries what it saw. */
const fakeServer = () => {
  const server = {
    revision: 2,
    draft: { content: 'morning', draftVersion: 3 } as Draft,
    deleted: false,
    log: [] as string[],
    /** While set, draft saves wait for `release`. */
    holding: false,
    held: [] as (() => void)[],
    /** Every draft save fails, if set. */
    failing: false,
    release: () => {
      server.holding = false;
      for (const answer of server.held.splice(0)) {
        answer();
      }
    },
    save: async (sent: Draft): Promise<SaveResult> => {
      const answer = (): SaveResult => {
        server.log.push(`save ${sent.content}`);
        if (server.failing) {
          return { kind: 'failed', error: new Error('unreachable') };
        }
        if (sent.content.length > 40) {
          return { kind: 'rejected', error: new Error('too large'), permanent: false };
        }
        if (sent.content === server.draft.content) {
          return { kind: 'saved', draftVersion: server.draft.draftVersion };
        }
        if (sent.draftVersion !== server.draft.draftVersion) {
          return { kind: 'conflict', server: server.draft };
        }
        server.draft = { content: sent.content, draftVersion: server.draft.draftVersion + 1 };

        return { kind: 'saved', draftVersion: server.draft.draftVersion };
      };
      if (server.holding) {
        return new Promise((resolve) => server.held.push(() => resolve(answer())));
      }

      return Promise.resolve(answer());
    },
    deleteDocument: async (seen: { revision: number; draftVersion: number }): Promise<void> => {
      server.log.push(`delete ${seen.revision} ${seen.draftVersion}`);
      if (seen.revision !== server.revision || seen.draftVersion !== server.draft.draftVersion) {
        throw new Error('document_changed');
      }
      server.deleted = true;
    },
  };

  return server;
};

let server: ReturnType<typeof fakeServer>;
let autosave: Autosave;

/** Lets every answer and continuation run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

/** Sends the delete of a capture; resolves to undefined when it went through, its error otherwise. */
const send = async (capture: DeleteCapture): Promise<unknown> =>
  deleteAsSeen(autosave, capture, async (seen) => server.deleteDocument(seen)).then(
    () => undefined,
    (error: unknown) => error,
  );

describe('deleting as the screen saw it', () => {
  beforeEach(() => {
    server = fakeServer();
    autosave = createAutosave({ base: { ...server.draft }, save: server.save, debounceMs: 1000 });
  });

  afterEach(() => {
    autosave.dispose();
  });

  it('carries the head shown and the confirmed draft, without saving anything', async () => {
    expect(await send(captureDelete(autosave, 2, false))).toBeUndefined();
    expect(server.log).toEqual(['delete 2 3']);
    expect(server.deleted).toBe(true);
  });

  it('carries the draft version taken at the confirmation: a newer draft read meanwhile gets a refusal', async () => {
    const capture = captureDelete(autosave, 2, false);
    server.draft = { content: 'morning, two more pages', draftVersion: 4 };
    autosave.refresh(server.draft);

    expect(((await send(capture)) as Error).message).toBe('document_changed');
    expect(server.deleted).toBe(false);
  });

  it('saves the text on screen first, and carries the version the server gave it', async () => {
    autosave.edit('morning, last line');
    expect(await send(captureDelete(autosave, 2, false))).toBeUndefined();
    expect(server.log).toEqual(['save morning, last line', 'delete 2 4']);
  });

  it('waits for a text typed while an earlier save was in flight, then carries its version', async () => {
    server.holding = true;
    autosave.edit('morning, one');
    void autosave.flush();
    await settle();
    autosave.edit('morning, one, two');

    const deleting = send(captureDelete(autosave, 2, false));
    server.release();
    await settle();

    expect(await deleting).toBeUndefined();
    expect(server.log).toEqual(['save morning, one', 'save morning, one, two', 'delete 2 5']);
  });

  it('keeps the head shown at the confirmation when a newer one arrives before the held save answers', async () => {
    server.holding = true;
    autosave.edit('evening');
    const deleting = send(captureDelete(autosave, 2, false));
    await settle();
    // Another device saves the same text as a version and as its draft; this app reads the document meanwhile.
    server.revision = 3;
    server.draft = { content: 'evening', draftVersion: 4 };
    autosave.refresh(server.draft);
    server.release();

    expect(((await deleting) as Error).message).toBe('document_changed');
    expect(server.log).toEqual(['save evening', 'delete 2 4']);
    expect(server.deleted).toBe(false);
  });

  it.each([
    ['another write of the editor runs', true, 'busy'],
    ['the draft is in conflict', false, 'conflict'],
  ])('sends nothing when %s', async (_case, busy, reason) => {
    if (!busy) {
      server.draft = { content: 'theirs', draftVersion: 4 };
      autosave.edit('mine');
      await autosave.flush();
    }
    server.log = [];

    const error = await send(captureDelete(autosave, 2, busy));
    expect(error instanceof DeleteRefused && error.reason).toBe(reason);
    expect(server.log).toEqual([]);
  });

  it('sends nothing when the text on screen could not be saved first', async () => {
    server.failing = true;
    autosave.edit('morning, unsent');

    const error = await send(captureDelete(autosave, 2, false));
    expect((error as DeleteRefused).reason).toBe('notSaved');
    expect(server.log).toEqual(['save morning, unsent']);
  });

  it('sends nothing when the save of the text on screen meets a conflict', async () => {
    server.draft = { content: 'theirs', draftVersion: 4 };
    autosave.edit('mine');

    const error = await send(captureDelete(autosave, 2, false));
    expect((error as DeleteRefused).reason).toBe('notSaved');
    expect(server.log).toEqual(['save mine']);
  });

  it('deletes a refused text against the last confirmed draft: the writer confirmed with it on screen', async () => {
    autosave.edit('a text far too long for this fake server to accept');
    await autosave.flush();
    expect(autosave.getSnapshot().status).toBe('rejected');

    expect(await send(captureDelete(autosave, 2, false))).toBeUndefined();
    expect(server.log.at(-1)).toBe('delete 2 3');
  });
});
