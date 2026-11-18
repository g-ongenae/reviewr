import type { CreateRevisionInput, Document } from '@reviewr/shared';
import { ApiError, NetworkError } from '@reviewr/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAutosave, type Autosave } from './autosave/autosave';
import { draftOf, toSaveResult } from './autosave/useAutosave';
import { beforeRestoreName, restore, restoreMessage, restoreRefusal, textMoved, type RestoreOptions } from './restore';

const conflictError = (body: object) => new ApiError(409, { statusCode: 409, message: 'Conflict', ...body });

/** A server with one document, at revision `revision`, whose draft is `draft`, with the API's rules for both writes. */
const fakeServer = (revision = 1, head = 'the head') => {
  const server = {
    document: {
      id: 'doc',
      title: 'Title',
      revision,
      content: head,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      draft: { content: head, draftVersion: 1, baseRevision: revision === 0 ? null : revision },
    } satisfies Document,
    versions: [] as { name: string | null | undefined; content: string }[],
    /** Thrown by every request while set. */
    failing: undefined as Error | undefined,
    /** How many version requests reached the server. */
    revisionRequests: 0,
    /** Called before a request is answered: another device, or the writer typing. */
    before: undefined as (() => void) | undefined,
    saveDraft(input: { content: string; draftVersion: number }) {
      server.before?.();
      if (server.failing !== undefined) throw server.failing;
      const { draft } = server.document;
      if (draft.content === input.content) return draft;
      if (draft.draftVersion !== input.draftVersion) throw conflictError({ code: 'draft_conflict', draft });
      server.document = { ...server.document, draft: { ...draft, ...input, draftVersion: draft.draftVersion + 1 } };
      return server.document.draft;
    },
    createRevision(input: CreateRevisionInput): Document {
      server.revisionRequests++;
      server.before?.();
      if (server.failing !== undefined) throw server.failing;
      const { draft, revision: current, content } = server.document;
      if (draft.draftVersion !== input.draftVersion) throw conflictError({ code: 'draft_conflict', draft });
      if (draft.content === content) return server.document;
      if (current !== (input.baseRevision ?? 0)) throw conflictError({ code: 'stale_revision', revision: current });
      server.versions.push({ name: input.name, content: draft.content });
      server.document = {
        ...server.document,
        revision: current + 1,
        content: draft.content,
        draft: { ...draft, baseRevision: current + 1 },
      };
      return server.document;
    },
    /** Another device saves a draft. */
    otherDevice(content: string) {
      const { draft } = server.document;
      server.document = { ...server.document, draft: { ...draft, content, draftVersion: draft.draftVersion + 1 } };
    },
  };
  return server;
};

const setup = (revision = 1, head = 'the head') => {
  const server = fakeServer(revision, head);
  const autosave: Autosave = createAutosave({
    base: { content: head, draftVersion: 1 },
    debounceMs: 60_000,
    retryDelayMs: () => 60_000,
    save: async (draft) => {
      await Promise.resolve();
      try {
        return { kind: 'saved', draftVersion: server.saveDraft(draft).draftVersion };
      } catch (error) {
        return toSaveResult(error);
      }
    },
  });
  const apply = vi.fn(() => autosave.edit('an old text'));
  const options = (overrides: Partial<RestoreOptions> = {}): RestoreOptions => ({
    autosave,
    head: { revision: server.document.revision, content: server.document.content },
    busy: () => false,
    gone: () => false,
    createRevision: async (input) => {
      await Promise.resolve();
      return server.createRevision(input);
    },
    titleEdits: () => 0,
    active: () => true,
    onKept: (saved) => autosave.refresh(draftOf(saved)),
    apply,
    now: () => new Date('2026-11-18T10:00:00Z'),
    ...overrides,
  });
  return { server, autosave, apply, options };
};

describe('restore', () => {
  it('keeps a text in no version as "Before restore", then puts the old text in the editor', async () => {
    const { server, autosave, apply, options } = setup();
    autosave.edit('today’s draft');
    expect(await restore(options())).toEqual({ kind: 'restored' });
    expect(server.versions).toEqual([{ name: 'Before restore — 18 Nov', content: 'today’s draft' }]);
    expect(apply).toHaveBeenCalledOnce();
    expect(autosave.getSnapshot()).toMatchObject({ status: 'unsaved', content: 'an old text' });
    // The restored text is sent on the draft the version left, without a conflict.
    await autosave.flush();
    expect(server.document.draft.content).toBe('an old text');
  });

  it('keeps an autosaved draft too: saved as a draft is not saved as a version', async () => {
    const { server, autosave, options } = setup();
    autosave.edit('saved, in no version');
    await autosave.flush();
    expect(await restore(options())).toEqual({ kind: 'restored' });
    expect(server.versions.map((version) => version.content)).toEqual(['saved, in no version']);
  });

  it('makes no version when the text on screen is the head’s, and restores at once', () => {
    const { server, apply, options } = setup();
    void restore(options());
    // Before the promise settles: nothing waits.
    expect(apply).toHaveBeenCalledOnce();
    expect(server.versions).toEqual([]);
  });

  it('keeps the text of a document without a version yet as its first version', async () => {
    const { server, autosave, options } = setup(0, '');
    autosave.edit('a first text');
    expect(await restore(options())).toEqual({ kind: 'restored' });
    expect(server.document.revision).toBe(1);
    expect(server.versions).toEqual([{ name: 'Before restore — 18 Nov', content: 'a first text' }]);
  });

  it('saves over a head that moved elsewhere: that version stays, and the text is kept after it', async () => {
    const { server, autosave, options } = setup();
    const opened = options();
    server.document = { ...server.document, revision: 2, content: 'from the other device' };
    autosave.edit('mine');
    expect(await restore(opened)).toEqual({ kind: 'restored' });
    expect(server.document.revision).toBe(3);
    expect(server.versions.map((version) => version.content)).toEqual(['mine']);
  });

  it('restores nothing when the server is unreachable, and leaves the text alone', async () => {
    const { server, autosave, apply, options } = setup();
    server.failing = new NetworkError(new TypeError('offline'));
    autosave.edit('today');
    const outcome = await restore(options());
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(restoreMessage(outcome)).toContain('the server is unreachable');
    expect(apply).not.toHaveBeenCalled();
    expect(autosave.getSnapshot().content).toBe('today');
  });

  it('restores nothing when the version is refused after the draft was saved', async () => {
    const { server, autosave, apply, options } = setup();
    autosave.edit('today');
    const outcome = await restore(options({ createRevision: () => Promise.reject(new ApiError(500, undefined)) }));
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(apply).not.toHaveBeenCalled();
    expect(server.document.draft.content).toBe('today');
  });

  it('restores nothing when the server refuses the text on screen', async () => {
    const { server, autosave, apply, options } = setup();
    server.failing = new ApiError(413, { statusCode: 413, message: 'Draft too large' });
    autosave.edit('a text too large');
    const outcome = await restore(options());
    expect(outcome).toMatchObject({ kind: 'failed', error: server.failing });
    expect(restoreMessage(outcome)).toContain('could not be kept as a version first');
    expect(apply).not.toHaveBeenCalled();
    expect(autosave.getSnapshot().content).toBe('a text too large');
  });

  it('restores nothing when the draft moved elsewhere while the text was being kept: it is a conflict', async () => {
    const { server, autosave, apply, options } = setup();
    autosave.edit('mine');
    await autosave.flush();
    server.before = () => {
      server.before = undefined;
      server.otherDevice('theirs');
    };
    expect(await restore(options())).toEqual({ kind: 'refused', reason: 'conflict' });
    expect(apply).not.toHaveBeenCalled();
    expect(autosave.getSnapshot()).toMatchObject({ status: 'conflict', content: 'mine' });
  });

  it('keeps an empty draft when the head it knows is at revision 0: another device may have saved a version', async () => {
    const { server, autosave, apply, options } = setup(1, 'saved elsewhere as revision 1');
    autosave.edit('');
    expect(await restore(options({ head: { revision: 0, content: '' } }))).toEqual({ kind: 'restored' });
    expect(server.versions).toEqual([{ name: 'Before restore — 18 Nov', content: '' }]);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('restores over an empty draft of a document with no version at all: the keep is a no-op, nothing is lost', async () => {
    const { server, apply, options } = setup(0, '');
    expect(await restore(options())).toEqual({ kind: 'restored' });
    expect(server.revisionRequests).toBe(1);
    expect(server.document.revision).toBe(0);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('restores nothing when the editor is gone during the keep, which is still published', async () => {
    const { server, autosave, apply, options } = setup();
    autosave.edit('mine');
    let active = true;
    const onKept = vi.fn();
    const outcome = await restore(
      options({
        active: () => active,
        onKept,
        createRevision: async (input) => {
          active = false;
          await Promise.resolve();
          return server.createRevision(input);
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'abandoned' });
    expect(restoreMessage(outcome)).toBeUndefined();
    expect(onKept).toHaveBeenCalledOnce();
    expect(server.versions.map((version) => version.content)).toEqual(['mine']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('restores nothing when the title was edited during the keep', async () => {
    const { server, autosave, apply, options } = setup();
    autosave.edit('mine');
    let titleEdits = 4;
    const outcome = await restore(
      options({
        titleEdits: () => titleEdits,
        createRevision: async (input) => {
          titleEdits++;
          await Promise.resolve();
          return server.createRevision(input);
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'failed', error: textMoved });
    expect(apply).not.toHaveBeenCalled();
    expect(server.versions.map((version) => version.content)).toEqual(['mine']);
  });

  describe('text typed during the restore', () => {
    it('while the draft is being saved: nothing is restored, and the typed text is kept', async () => {
      const { server, autosave, apply, options } = setup();
      autosave.edit('mine');
      server.before = () => {
        server.before = undefined;
        autosave.edit('mine, and more');
      };
      const outcome = await restore(options());
      expect(outcome).toEqual({ kind: 'failed', error: textMoved });
      expect(restoreMessage(outcome)).toContain('your text or title changed during the restore');
      expect(apply).not.toHaveBeenCalled();
      // The draft saved is not the text asked for: no version is even asked for.
      expect(server.revisionRequests).toBe(0);
      await autosave.flush();
      expect(server.document.draft.content).toBe('mine, and more');
    });

    it('while the version is being saved: nothing is restored, and the typed text is kept', async () => {
      const { server, autosave, apply, options } = setup();
      autosave.edit('mine');
      await autosave.flush();
      let typed = false;
      const outcome = await restore(
        options({
          createRevision: async (input) => {
            autosave.edit('mine, and more');
            typed = true;
            await Promise.resolve();
            return server.createRevision(input);
          },
        }),
      );
      expect(typed).toBe(true);
      expect(outcome).toEqual({ kind: 'failed', error: textMoved });
      expect(apply).not.toHaveBeenCalled();
      // The version holds the text on screen when the restore was asked for.
      expect(server.versions.map((version) => version.content)).toEqual(['mine']);
      expect(autosave.getSnapshot().content).toBe('mine, and more');
    });

    it('sent by the autosave before the version: the version is not made, nothing is restored', async () => {
      const { server, autosave, apply, options } = setup();
      autosave.edit('mine');
      await autosave.flush();
      const outcome = await restore(
        options({
          createRevision: async (input) => {
            autosave.edit('mine, and more');
            await autosave.flush();
            return server.createRevision(input);
          },
        }),
      );
      expect(outcome).toEqual({ kind: 'failed', error: textMoved });
      expect(apply).not.toHaveBeenCalled();
      expect(autosave.getSnapshot()).toMatchObject({ status: 'saved', content: 'mine, and more' });
      expect(server.versions).toEqual([]);
    });
  });

  describe('is refused, with nothing sent', () => {
    it('while a conflict holds the text', async () => {
      const { server, autosave, apply, options } = setup();
      server.otherDevice('theirs');
      autosave.edit('mine');
      await autosave.flush();
      expect(autosave.getSnapshot().status).toBe('conflict');
      const outcome = await restore(options());
      expect(outcome).toEqual({ kind: 'refused', reason: 'conflict' });
      expect(restoreMessage(outcome)).toContain('changed on another device');
      expect(apply).not.toHaveBeenCalled();
    });

    it('while a merged text is being saved', async () => {
      const { apply, options } = setup();
      expect(await restore(options({ busy: () => true }))).toEqual({ kind: 'refused', reason: 'busy' });
      expect(apply).not.toHaveBeenCalled();
    });

    it('for a deleted document, even with the head’s text on screen', async () => {
      const { apply, options } = setup();
      const outcome = await restore(options({ gone: () => true }));
      expect(outcome).toEqual({ kind: 'refused', reason: 'deleted' });
      expect(restoreMessage(outcome)).toContain('deleted elsewhere');
      expect(apply).not.toHaveBeenCalled();
    });
  });
});

describe('restoreRefusal', () => {
  const base = { content: 'a', draftVersion: 1 };
  it('tells a deletion, a merge being saved and a conflict apart, in that order', () => {
    const error = new ApiError(404, undefined);
    expect(restoreRefusal({ status: 'rejected', error, permanent: true, content: 'a', base }, true, false)).toBe(
      'deleted',
    );
    expect(restoreRefusal({ status: 'saved', content: 'a', base }, true, false)).toBe('busy');
    expect(restoreRefusal({ status: 'conflict', server: base, content: 'b', base }, false, false)).toBe('conflict');
    expect(restoreRefusal({ status: 'rejected', error, permanent: false, content: 'a', base }, false, false)).toBe(
      undefined,
    );
    expect(restoreRefusal({ status: 'retrying', error, attempt: 1, content: 'a', base }, false, false)).toBe(undefined);
  });
});

describe('beforeRestoreName', () => {
  it('names the version by its day, as the mobile app does', () => {
    expect(beforeRestoreName(new Date('2026-11-16T12:00:00Z'))).toBe('Before restore — 16 Nov');
  });
});
