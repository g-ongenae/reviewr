import type { CreateRevisionInput, Document, DocumentDraft, SaveDraftInput } from '@reviewr/shared';
import { describe, expect, it } from 'vitest';
import { createAutosave, type Autosave, type Timers } from '../autosave/autosave';
import { hiddenTexts, sessionFor, versionName, type ReconcileSession, type SessionOptions } from './session';

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
 * writing at random points, before any request (back to an earlier text, or exactly a local text); failed requests and
 * lost answers; reads handed to the machines; edits; retries, dismissals, a second confirmation while one runs; the
 * session looked up again as an editor coming back does. Some runs have two tabs, each with its machine and its
 * session, on the same server.
 *
 * Checked at every stop and at the end, for each tab: every text its session was given (each local text and each
 * other device's text it was confirmed with) and every result not discarded by the writer is the server's draft, in a
 * revision, or shown to the writer: the local text, the conflict's other text, the merged text, or a text listed by
 * `hiddenTexts`. Only what the session and the machine expose counts. Every text of another writer that a session's
 * write replaced is on the server or shown by a tab. A version named for a side holds a text of that side. Every
 * confirmation ends, and once the server is quiet every conflict ends applied.
 */
describe('reconciliation session, randomised', () => {
  const texts = ['', 'A', 'B', 'C', 'D'];
  const results = [...texts, 'R1', 'R2'];

  const run = async (seed: number, tabCount: number) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const steps: string[] = [];
    const fail = (message: string): never => {
      throw new Error(`seed ${seed}, ${tabCount} tab(s): ${message}\n  ${steps.join('\n  ')}`);
    };

    // The server.
    const head0 = pick(texts);
    let head = head0;
    let revision = 1;
    const revisions: { content: string; name: string | null; by: number }[] = [{ content: head0, name: null, by: -1 }];
    let draft = { content: random() < 0.5 ? head0 : pick(texts), draftVersion: 1 };
    /** Who wrote the draft: a tab's index, or -1 for the other device. */
    let draftBy = -1;
    const otherTexts = new Set<string>([draft.content]);
    /** Texts of another writer that a session's write replaced. */
    const replaced = new Set<string>();
    /** The tab whose session is writing, if one is. */
    let sessionWriter: number | undefined;

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
      draftBy = -1;
      otherTexts.add(content);
    };
    const serverSaveDraft = ({ content, draftVersion }: SaveDraftInput, by: number): DocumentDraft => {
      if (draft.content === content) return { ...draft, baseRevision: revision };
      if (draft.draftVersion !== draftVersion) throw conflictError;
      if (sessionWriter !== undefined && draftBy !== sessionWriter) replaced.add(draft.content);
      draft = { content, draftVersion: draft.draftVersion + 1 };
      draftBy = by;
      return { ...draft, baseRevision: revision };
    };
    const serverCreateRevision = ({ name, draftVersion, baseRevision }: CreateRevisionInput, by: number): Document => {
      if (draft.draftVersion !== draftVersion) throw conflictError;
      if (draft.content === head) return toDocument();
      if (revision !== baseRevision) throw conflictError;
      revision++;
      head = draft.content;
      revisions.push({ content: head, name: name ?? null, by });
      return toDocument();
    };

    // The network: the other device may write first; a request may fail before the server, or lose its answer.
    let failureRate = 0.15;
    let otherRate = tabCount === 1 ? 0.15 : 0.05;
    let onRequest = () => {};
    const request = async <T>(label: string, handle: () => T): Promise<T> => {
      await Promise.resolve();
      onRequest();
      if (random() < otherRate) otherWrites(pick([...texts, ...tabs.flatMap((tab) => [...tab.texts])]));
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

    // Timers on a virtual clock, for the machines' debounce and retries.
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

    /** A tab: its machine opened on the draft, and its session, looked up again as an editor coming back does. */
    interface Tab {
      index: number;
      autosave: Autosave;
      session: () => ReconcileSession;
      /** Texts this tab typed or confirmed. */
      texts: Set<string>;
      /** Texts given to its session, and results confirmed and not discarded. */
      required: Set<string>;
      /** Results not yet applied nor discarded. */
      pending: Set<string>;
    }

    const createTab = (index: number): Tab => {
      const tag = tabCount === 1 ? '' : ` [tab ${index}]`;
      const autosave: Autosave = createAutosave({
        base: { ...draft },
        timers,
        debounceMs: 10,
        retryDelayMs: () => 100,
        save: async (sent) => {
          try {
            const saved = await request(`machine saves ${JSON.stringify(sent.content)}${tag}`, () =>
              serverSaveDraft(sent, index),
            );
            return { kind: 'saved', draftVersion: saved.draftVersion };
          } catch (error) {
            if (error === conflictError) return { kind: 'conflict', server: { ...draft } };
            return { kind: 'failed', error };
          }
        },
      });
      const options: SessionOptions = {
        id: 'doc',
        autosave,
        api: {
          getDocument: () => request(`GET${tag}`, toDocument),
          saveDraft: (_, input) =>
            request(`PUT ${JSON.stringify(input.content)}${tag}`, () => {
              sessionWriter = index;
              try {
                return serverSaveDraft(input, index);
              } finally {
                sessionWriter = undefined;
              }
            }),
          createRevision: (_, input) =>
            request(`POST ${input.name ?? ''}${tag}`, () => serverCreateRevision(input, index)),
        },
        isConflict: (error) => error === conflictError,
        // As the editor's cache does: the machine is told about the document's draft.
        onDocument: (document) => document.draft && autosave.refresh(document.draft),
        now: () => new Date(2026, 10, 13, 12),
      };
      return {
        index,
        autosave,
        session: () => sessionFor(options),
        texts: new Set(),
        required: new Set(),
        pending: new Set(),
      };
    };
    const tabs: Tab[] = [];
    for (let index = 0; index < tabCount; index++) tabs.push(createTab(index));
    const firsts = tabs.map((tab) => tab.session());

    const edit = (tab: Tab, content: string) => {
      steps.push(`writer types ${JSON.stringify(content)}${tabCount === 1 ? '' : ` in tab ${tab.index}`}`);
      tab.texts.add(content);
      tab.autosave.edit(content);
    };
    otherWrites(pick(texts.filter((text) => text !== draft.content)));
    for (const tab of tabs) {
      edit(
        tab,
        pick(texts.filter((text) => text !== draft.content && text !== tab.autosave.getSnapshot().base.content)),
      );
    }
    for (let i = 0; i < 20 && tabs.some((tab) => tab.autosave.getSnapshot().status !== 'conflict'); i++) {
      await tick(100);
    }

    /**
     * What a tab shows the writer: the local text, the conflict's other text and the merged text (the view), and the
     * texts `hiddenTexts` lists. The empty text holds nothing to lose.
     */
    const shownBy = (tab: Tab): Set<string> => {
      const machine = tab.autosave.getSnapshot();
      const state = tab.session().getSnapshot();
      const shown = new Set(['', machine.content, ...hiddenTexts(state, machine).map((item) => item.text)]);
      if (machine.status === 'conflict') shown.add(machine.server.content);
      if (state.result !== undefined) shown.add(state.result);
      return shown;
    };

    const check = (when: string) => {
      const kept = new Set([draft.content, ...revisions.map((item) => item.content)]);
      const shownByAny = new Set(tabs.flatMap((tab) => [...shownBy(tab)]));
      for (const tab of tabs) {
        if (tab.session().getSnapshot().running) fail(`${when}: tab ${tab.index} still running`);
        const shown = shownBy(tab);
        for (const text of [...tab.required, ...tab.pending]) {
          if (!kept.has(text) && !shown.has(text)) fail(`${when}: ${JSON.stringify(text)} of tab ${tab.index} is lost`);
        }
      }
      for (const text of replaced) {
        if (!kept.has(text) && !shownByAny.has(text)) fail(`${when}: replaced ${JSON.stringify(text)} is lost`);
      }
      for (const { content, name, by } of revisions) {
        const tab = tabs[by];
        if (tab === undefined) continue;
        const others = new Set([...otherTexts, ...tabs.filter((other) => other !== tab).flatMap((t) => [...t.texts])]);
        if (name?.startsWith('Other device') && !others.has(content)) {
          fail(`${when}: ${JSON.stringify(content)} kept as the other device's by tab ${by}`);
        }
        if (name?.startsWith('This device') && !tab.texts.has(content)) {
          fail(`${when}: ${JSON.stringify(content)} kept as this device's by tab ${by}`);
        }
      }
    };

    const confirm = async (tab: Tab, result: string) => {
      const machine = tab.autosave.getSnapshot();
      if (machine.status === 'conflict' && !tab.session().getSnapshot().running) {
        tab.required.add(machine.content);
        tab.required.add(machine.server.content);
        tab.pending.add(result);
        tab.texts.add(result);
      }
      steps.push(
        `confirm ${JSON.stringify(result)} [mine ${JSON.stringify(machine.content)}]${tabCount === 1 ? '' : ` in tab ${tab.index}`}`,
      );
      const second = random() < 0.2;
      const done = [tab.session().confirm(result)];
      if (second) {
        steps.push('confirm again while it runs');
        done.push(tab.session().confirm(pick(results)));
      }
      await Promise.all(done);
      await settle();
      const state = tab.session().getSnapshot();
      steps.push(state.stop === undefined ? 'applied' : `stopped: ${state.stop.reason}`);
      if (state.result === undefined) {
        // Applied: the result is the writer's text now, which they may change; the rest is kept.
        tab.required.clear();
        tab.pending.clear();
        // A replaced text that is the result is the draft again: from now on, only its writer can replace it.
        replaced.delete(result);
        if (state.texts.length > 0) fail('an applied session still holds texts');
      }
      check(`after confirming ${JSON.stringify(result)}`);
    };

    for (let step = 0; step < 30 * tabCount; step++) {
      if (tabs.some((tab, index) => tab.session() !== firsts[index])) fail('a session changed');
      const tab = pick(tabs);
      const roll = random();
      const machine = tab.autosave.getSnapshot();
      const { result } = tab.session().getSnapshot();
      if (roll < 0.2) {
        otherWrites(pick([...texts, ...tabs.flatMap((other) => [...other.texts])]));
      } else if (roll < 0.3) {
        steps.push(`read ${JSON.stringify(draft)}${tabCount === 1 ? '' : ` in tab ${tab.index}`}`);
        tab.autosave.refresh({ ...draft });
      } else if (roll < 0.38 && result === undefined) {
        edit(tab, pick([...texts, ...tab.texts]));
      } else if (roll < 0.45) {
        await tick(100);
      } else if (machine.status === 'conflict' || result !== undefined) {
        if (result !== undefined && random() < 0.5) {
          await confirm(tab, result);
        } else {
          if (result !== undefined) {
            steps.push(`dismiss ${JSON.stringify(result)}`);
            tab.session().dismissResult();
            tab.pending.delete(result);
          }
          // Now and then the writer edits while the confirmation runs (the editor prevents it; the session must not
          // apply its result over that text).
          if (random() < 0.1) {
            onRequest = () => {
              onRequest = () => {};
              edit(tab, pick(texts));
            };
          }
          await confirm(tab, pick(results));
          onRequest = () => {};
        }
      }
    }

    // The end: the server is quiet; the writer retries or confirms in each tab until no conflict is left.
    failureRate = 0;
    otherRate = 0;
    for (let round = 0; round < 10 * tabCount; round++) {
      await tick(1000);
      const tab = tabs.find(
        (candidate) =>
          candidate.session().getSnapshot().result !== undefined ||
          candidate.autosave.getSnapshot().status === 'conflict',
      );
      if (tab === undefined) break;
      const { result } = tab.session().getSnapshot();
      await confirm(tab, result ?? pick(results));
    }
    await tick(1000);
    check('at the end');
    for (const tab of tabs) {
      const final = tab.autosave.getSnapshot();
      const state = tab.session().getSnapshot();
      if (final.status !== 'saved' || state.result !== undefined || state.texts.length > 0) {
        fail(`tab ${tab.index} ends ${final.status} with ${JSON.stringify(state)}`);
      }
      tab.autosave.dispose();
    }
  };

  it('never loses a text over 300 random runs', async () => {
    for (let seed = 1; seed <= 300; seed++) await run(seed, 1);
  });

  it('never loses a text over 200 random runs with two tabs on the same server', async () => {
    for (let seed = 1; seed <= 200; seed++) await run(seed, 2);
  });
});
