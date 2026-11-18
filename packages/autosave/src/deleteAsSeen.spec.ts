import { describe, expect, it } from 'vitest';
import type { AutosaveState } from './autosave.js';
import { deleteAsSeen } from './deleteAsSeen.js';

const base = { content: 'morning', draftVersion: 3 };
const rendered = (state: Partial<AutosaveState>, writing = false) => ({
  state: { content: 'morning', base, status: 'saved', ...state } as AutosaveState,
  revision: 2,
  writing,
});

describe('deleteAsSeen', () => {
  it('carries the rendered head and the rendered confirmed draft', () => {
    expect(deleteAsSeen(rendered({}))).toEqual({ seen: { revision: 2, draftVersion: 3 } });
  });

  it('carries the confirmed draft under a text the server refused', () => {
    const refused = rendered({ status: 'rejected', content: 'too long', error: undefined, permanent: false });
    expect(deleteAsSeen(refused)).toEqual({ seen: { revision: 2, draftVersion: 3 } });
  });

  it.each([
    ['text waiting', { status: 'unsaved' }, false, 'not saved yet'],
    ['text being saved', { status: 'saving' }, false, 'not saved yet'],
    ['a save being retried', { status: 'retrying', error: undefined, attempt: 1 }, false, 'not saved yet'],
    ['a conflict', { status: 'conflict', server: base }, false, 'changed on another device'],
    ['another write', {}, true, 'in progress'],
  ])('refuses with %s', (_case, state, writing, reason) => {
    const decision = deleteAsSeen(rendered(state as Partial<AutosaveState>, writing));
    expect('refused' in decision && decision.refused.includes(reason)).toBe(true);
  });
});
