import type { CreateRevisionInput, Document, DocumentDraft, SaveDraftInput } from '@reviewr/shared';
import { describe, expect, it } from 'vitest';
import { createAutosave, type Autosave, type Timers } from '../autosave/autosave';
import { sessionFor, versionName, type ReconcileSession, type SessionOptions } from './session';

describe('versionName', () => {
  it('names the side and the day, day first with an English month', () => {
    const day = new Date(2026, 10, 13, 12);
    expect(versionName('theirs', day)).toBe('Other device — 13 Nov');
    expect(versionName('mine', day)).toBe('This device — 13 Nov');
  });
});

/** mulberry32: a small seeded generator, so a failing run can be replayed from its seed. */
const seeded = (seed: number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const conflictError = new Error('409 Conflict');
const failure = new Error('503 Service Unavailable');

/**
 * Random runs of reconciliations against a fake server with the rules of `saveDraft` and `createRevision`: random
 * texts (equal ones and the empty text included) for the head, the base, both sides and the results; another device
 * writing at random points, before any request (back to an earlier text, or exactly the local text); failed requests
 * and lost answers; reads handed to the machine; edits; retries, dismissals, a second confirmation while one runs; the
 * session looked up again as an editor coming back does.
 *
 * Checked at every stop and at the end: every text the session was given (each local text and each other device's
 * text it was confirmed with), every result not discarded by the writer, and every text of the other device that a
 * write of this device replaced, is the server's draft, in a revision, or held (the session's result or the texts it
 * keeps before applying one, or the machine's local text). A version named for a side holds a text of that side.
 * Every confirmation ends, and once the server is quiet the conflict always ends applied.
 */
describe('reconciliation session, randomised', () => {
  const texts = ['', 'A', 'B', 'C', 'D'];
  const results = [...texts, 'R1', 'R2'];

  const run = async (seed: number) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const steps: string[] = [];
    const fail = (message: string): never => {
      throw new Error(`seed ${seed}: ${message}\n  ${steps.join('\n  ')}`);
    };

    // The server.
    const head0 = pick(texts);
    let head = head0;
    let revision = 1;
    const revisions: { content: string; name: string | null }[] = [{ content: head0, name: null }];
    let draft = { content: random() < 0.5 ? head0 : pick(texts), draftVersion: 1 };
    let draftBy: 'this' | 'other' = 'other';
    const otherTexts = new Set<string>([draft.content]);
    const thisTexts = new Set<string>();
    /** Texts of the other device that a write of the session replaced. */
    const replaced = new Set<string>();
    let sessionWrites = false;

    const toDocument = (): Document => ({
      id: 'doc',
      title: null,
      revision,
      content: head,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      draft: { ...draft, baseRevision: revision },
    });
    const otherWrites = (content: string) => {
      steps.push(`other device writes ${JSON.stringify(content)}`);
      draft = { content, draftVersion: draft.draftVersion + 1 };
      draftBy = 'other';
      otherTexts.add(content);
    };
    const serverSaveDraft = ({ content, draftVersion }: SaveDraftInput): DocumentDraft => {
      if (draft.content === content) return { ...draft, baseRevision: revision };
      if (draft.draftVersion !== draftVersion) throw conflictError;
      if (draftBy === 'other' && sessionWrites) replaced.add(draft.content);
      draft = { content, draftVersion: draft.draftVersion + 1 };
      draftBy = 'this';
      return { ...draft, baseRevision: revision };
    };
    const serverCreateRevision = ({ name, draftVersion, baseRevision }: CreateRevisionInput): Document => {
      if (draft.draftVersion !== draftVersion) throw conflictError;
      if (draft.content === head) return toDocument();
      if (revision !== baseRevision) throw conflictError;
      revision++;
      head = draft.content;
      revisions.push({ content: head, name: name ?? null });
      return toDocument();
    };

    // The network: the other device may write first; a request may fail before the server, or lose its answer.
    let failureRate = 0.15;
    let otherRate = 0.15;
    let onRequest = () => {};
    const request = async <T>(label: string, handle: () => T): Promise<T> => {
      await Promise.resolve();
      onRequest();
      if (random() < otherRate) otherWrites(pick([...texts, ...thisTexts]));
      if (random() < failureRate) {
        steps.push(`${label}: failed`);
        throw failure;
      }
      let answer: T;
      try {
        answer = handle();
      } catch (error) {
        steps.push(`${label}: 409`);
        throw error;
      }
      if (random() < failureRate) {
        steps.push(`${label}: answer lost`);
        throw failure;
      }
      steps.push(`${label}: ok`);
      return answer;
    };

    // Timers on a virtual clock, for the machine's debounce and retries.
    let now = 0;
    let nextTimer = 0;
    const due: { at: number; id: number; callback: () => void }[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => {
        due.push({ at: now + ms, id: nextTimer, callback });
        return nextTimer++;
      },
      clearTimeout: (handle) => {
        const index = due.findIndex((timer) => timer.id === handle);
        if (index >= 0) due.splice(index, 1);
      },
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const tick = async (ms: number) => {
      now += ms;
      for (const timer of [...due].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && due.includes(timer)) {
          due.splice(due.indexOf(timer), 1);
          timer.callback();
          await settle();
        }
      }
    };

    // This device: its machine opened on the draft, then the writer types while the other device writes.
    const autosave: Autosave = createAutosave({
      base: { ...draft },
      timers,
      debounceMs: 10,
      retryDelayMs: () => 100,
      save: async (sent) => {
        try {
          const saved = await request(`machine saves ${JSON.stringify(sent.content)}`, () => serverSaveDraft(sent));
          return { kind: 'saved', draftVersion: saved.draftVersion };
        } catch (error) {
          if (error === conflictError) return { kind: 'conflict', server: { ...draft } };
          return { kind: 'failed', error };
        }
      },
    });
    const edit = (content: string) => {
      steps.push(`writer types ${JSON.stringify(content)}`);
      thisTexts.add(content);
      autosave.edit(content);
    };
    otherWrites(pick(texts.filter((text) => text !== draft.content)));
    edit(pick(texts.filter((text) => text !== draft.content && text !== autosave.getSnapshot().base.content)));
    for (let i = 0; i < 20 && autosave.getSnapshot().status !== 'conflict'; i++) await tick(100);

    const options: SessionOptions = {
      id: 'doc',
      autosave,
      api: {
        getDocument: () => request('GET', toDocument),
        saveDraft: (_, input) =>
          request(`PUT ${JSON.stringify(input.content)}`, () => {
            sessionWrites = true;
            try {
              return serverSaveDraft(input);
            } finally {
              sessionWrites = false;
            }
          }),
        createRevision: (_, input) => request(`POST ${input.name ?? ''}`, () => serverCreateRevision(input)),
      },
      isConflict: (error) => error === conflictError,
      // As the editor's cache does: the machine is told about the document's draft.
      onDocument: (document) => document.draft && autosave.refresh(document.draft),
      now: () => new Date(2026, 10, 13, 12),
    };
    // An editor coming back looks the session up again: always the same one.
    const session = (): ReconcileSession => sessionFor(options);
    const first = session();

    /** Every text given to a session, results confirmed and not discarded, and the texts given but not yet applied. */
    const required = new Set<string>();
    const pending = new Set<string>();
    let given: string[] = [];

    const check = (when: string) => {
      const state = session().getSnapshot();
      if (state.running) fail(`${when}: still running`);
      const machine = autosave.getSnapshot();
      const held = new Set([machine.content, ...given, ...(state.result === undefined ? [] : [state.result])]);
      const kept = new Set([draft.content, ...revisions.map((item) => item.content)]);
      for (const text of [...required, ...pending, ...replaced]) {
        if (!kept.has(text) && !held.has(text)) fail(`${when}: ${JSON.stringify(text)} is lost`);
      }
      for (const { content, name } of revisions) {
        if (name?.startsWith('Other device') && !otherTexts.has(content)) {
          fail(`${when}: ${JSON.stringify(content)} kept as the other device's`);
        }
        if (name?.startsWith('This device') && !thisTexts.has(content)) {
          fail(`${when}: ${JSON.stringify(content)} kept as this device's`);
        }
      }
    };

    const confirm = async (result: string) => {
      const machine = autosave.getSnapshot();
      if (machine.status === 'conflict' && !session().getSnapshot().running) {
        required.add(machine.content);
        required.add(machine.server.content);
        pending.add(result);
        given.push(machine.content, machine.server.content);
        thisTexts.add(result);
      }
      steps.push(`confirm ${JSON.stringify(result)} [mine ${JSON.stringify(machine.content)}]`);
      const second = random() < 0.2;
      const done = [session().confirm(result)];
      if (second) {
        steps.push('confirm again while it runs');
        done.push(session().confirm(pick(results)));
      }
      await Promise.all(done);
      await settle();
      const state = session().getSnapshot();
      steps.push(state.stop === undefined ? 'applied' : `stopped: ${state.stop.reason}`);
      if (state.result === undefined) {
        // Applied: the result is the writer's text now, which they may change; the rest is kept.
        given = [];
        pending.clear();
        required.delete(result);
        // A replaced text that is the result is the draft again: from now on, only its writer can replace it.
        replaced.delete(result);
      }
      check(`after confirming ${JSON.stringify(result)}`);
    };

    for (let step = 0; step < 30; step++) {
      if (session() !== first) fail('the session changed');
      const roll = random();
      const machine = autosave.getSnapshot();
      const { result } = session().getSnapshot();
      if (roll < 0.2) {
        otherWrites(pick([...texts, ...thisTexts]));
      } else if (roll < 0.3) {
        steps.push(`read ${JSON.stringify(draft)}`);
        autosave.refresh({ ...draft });
      } else if (roll < 0.38 && result === undefined) {
        edit(pick([...texts, ...thisTexts]));
      } else if (roll < 0.45) {
        await tick(100);
      } else if (machine.status === 'conflict' || result !== undefined) {
        if (result !== undefined && random() < 0.5) {
          await confirm(result);
        } else {
          if (result !== undefined) {
            steps.push(`dismiss ${JSON.stringify(result)}`);
            session().dismissResult();
            pending.delete(result);
          }
          // Now and then the writer edits while the confirmation runs (the editor prevents it; the session must not
          // apply its result over that text).
          if (random() < 0.1) {
            onRequest = () => {
              onRequest = () => {};
              edit(pick(texts));
            };
          }
          await confirm(pick(results));
          onRequest = () => {};
        }
      }
    }

    // The end: the server is quiet; the writer retries or confirms until the conflict is resolved.
    failureRate = 0;
    otherRate = 0;
    for (let round = 0; round < 10; round++) {
      await tick(1000);
      const { result } = session().getSnapshot();
      if (result !== undefined) await confirm(result);
      else if (autosave.getSnapshot().status === 'conflict') await confirm(pick(results));
      else break;
    }
    await tick(1000);
    check('at the end');
    const final = autosave.getSnapshot();
    if (final.status !== 'saved' || session().getSnapshot().result !== undefined) {
      fail(`ends ${final.status} with ${JSON.stringify(session().getSnapshot())}`);
    }
    autosave.dispose();
  };

  it('never loses a text over 300 random runs', async () => {
    for (let seed = 1; seed <= 300; seed++) await run(seed);
  });
});
