import { describe, expect, it } from 'vitest';
import { base, mine, theirs } from './fixtures';
import {
  createReconciliation,
  dismissOrphan,
  keepEarlierChoice,
  recompute,
  remaining,
  resolveConflict,
  resolvedText,
  toParagraphs,
  type Reconciliation,
} from './reconcile';

const resolveAll = (state: Reconciliation, ...choices: Parameters<typeof resolveConflict>[2][]): Reconciliation =>
  choices.reduce((next, choice, index) => resolveConflict(next, index, choice), state);

describe('reconciliation state', () => {
  it('applies changes that do not overlap and has nothing to resolve', () => {
    const state = createReconciliation(
      'Il pleuvait sur la ville. Personne ne sortait.',
      'Il pleuvait fort sur la ville. Personne ne sortait.',
      'Il pleuvait sur la ville. Personne ne sortait encore.',
    );

    expect(state.conflicts).toHaveLength(0);
    expect(remaining(state)).toBe(0);
    expect(resolvedText(state)).toBe('Il pleuvait fort sur la ville. Personne ne sortait encore.');
  });

  it('finds the three conflicts of the fixture, with the deletion on this device as one of them', () => {
    const state = createReconciliation(base, mine, theirs);

    expect(state.conflicts.map((entry) => [entry.part.mine, entry.part.theirs])).toEqual([
      ['la gardienne montait', 'Marthe gravissait'],
      ['l’ardoise ', 'le vert '],
      ['', ', presque effacée par les embruns'],
    ]);
    expect(base.slice(state.conflicts[1]?.start, state.conflicts[1]?.end)).toBe('le gris ');
  });

  it('gives no text until every conflict is resolved', () => {
    let state = createReconciliation(base, mine, theirs);
    state = resolveAll(state, 'mine', 'theirs');

    expect(remaining(state)).toBe(1);
    expect(resolvedText(state)).toBeUndefined();
    expect(resolvedText(resolveConflict(state, 2, 'mine'))).toBeDefined();
  });

  it('resolves with mine, theirs, both and a hand edit', () => {
    const state = createReconciliation(base, mine, theirs);

    expect(resolvedText(resolveAll(state, 'mine', 'mine', 'mine'))).toBe(
      // Mine everywhere, plus the other device's changes that did not overlap.
      mine.replace('Le phare', 'Le vieux phare').replace('une lettre', 'une enveloppe'),
    );
    const text = resolvedText(resolveAll(state, 'theirs', 'both', { edit: ', effacée' }));
    expect(text).toContain('Chaque soir, Marthe gravissait les cent');
    // Keep both joins the texts exactly as written: no separator is invented.
    expect(text).toContain('entre l’ardoise le vert et le bleu');
    expect(text).toContain('L’écriture était fine, effacée.');
  });

  it('keeps a hand edit when the writer switches to another choice', () => {
    let state = createReconciliation(base, mine, theirs);
    state = resolveConflict(state, 1, { edit: 'l’ardoise verte ' });
    state = resolveConflict(state, 1, 'theirs');

    expect(state.conflicts[1]?.draft).toBe('l’ardoise verte ');
  });

  it('keeps resolutions over a recompute where the conflict did not change', () => {
    let state = resolveAll(createReconciliation(base, mine, theirs), 'theirs', { edit: 'le bleu-gris ' });
    state = recompute(state, base, mine, theirs.replace('les embruns', 'l’écume'));

    expect(state.conflicts[0]?.resolution).toBe('theirs');
    expect(state.conflicts[1]?.resolution).toEqual({ edit: 'le bleu-gris ' });
    expect(state.conflicts.every((entry) => !entry.recheck)).toBe(true);
    expect(state.conflicts[2]?.part.theirs).toBe(', presque effacée par l’écume');
  });

  it('keeps a hand edit where the other side changed the passage again, and asks to check it', () => {
    let state = resolveConflict(createReconciliation(base, mine, theirs), 1, { edit: 'le bleu-gris ' });
    state = recompute(state, base, mine, theirs.replace('le vert', 'le vert pâle'));

    expect(state.conflicts[1]?.part.theirs).toBe('le vert pâle ');
    expect(state.conflicts[1]?.resolution).toEqual({ edit: 'le bleu-gris ' });
    expect(state.conflicts[1]?.recheck).toBe(true);
    expect(state.orphans).toEqual([]);

    state = resolveAll(state, 'mine');
    state = resolveConflict(state, 2, 'mine');
    expect(remaining(state)).toBe(1);
    state = keepEarlierChoice(state, 1);
    expect(resolvedText(state)).toContain('entre le bleu-gris et le bleu');
  });

  it('never drops a hand edit whose conflict disappeared: it waits until the writer dismisses it', () => {
    let state = resolveAll(createReconciliation(base, mine, theirs), 'mine', { edit: 'le bleu-gris ' });
    // The other device goes back to the base there: the conflicts disappear and this device's changes apply.
    state = recompute(
      state,
      base,
      mine,
      theirs.replace('le vert', 'le gris').replace('Marthe gravissait', 'Marthe montait'),
    );

    expect(state.conflicts).toHaveLength(1);
    expect(state.orphans).toEqual(['le bleu-gris ']);
    expect(state.lostChoices).toBe(1);
    state = resolveConflict(state, 0, 'theirs');
    expect(remaining(state)).toBe(1);
    expect(resolvedText(state)).toBeUndefined();

    state = dismissOrphan(state, 0);
    expect(resolvedText(state)).toContain('la gardienne montait');
  });

  it('turns hand edits into orphans when the base itself changed', () => {
    let state = resolveConflict(createReconciliation(base, mine, theirs), 1, { edit: 'le bleu-gris ' });
    state = recompute(state, `${base} Fin.`, mine, theirs);

    expect(state.orphans).toEqual(['le bleu-gris ']);
    expect(state.conflicts.every((entry) => entry.resolution === undefined)).toBe(true);
  });

  it('splits the merged text into lines, keeping the conflicts in place', () => {
    const lines = toParagraphs(createReconciliation(base, mine, theirs).merge);

    expect(lines).toHaveLength(5);
    expect(lines[1]).toEqual([]);
    expect(lines.map((runs) => runs.filter((run) => run.kind === 'conflict').length)).toEqual([1, 0, 1, 0, 1]);
  });
});
