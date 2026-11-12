import { resolveMerge, type MergeResult } from '@reviewr/merge';
import { describe, expect, it } from 'vitest';
import { base, closing, merged, middle, mine, opening, theirs } from './fixtures';
import {
  createReconciliation,
  dismissOrphan,
  keepEarlierChoice,
  nextFocus,
  recompute,
  remaining,
  resolveConflict,
  resolvedText,
  toParagraphs,
  type Reconciliation,
} from './reconcile';

const resolveAll = (state: Reconciliation, ...choices: Parameters<typeof resolveConflict>[2][]): Reconciliation =>
  choices.reduce((next, choice, index) => resolveConflict(next, index, choice), state);

/** Rebuilds the text from the paragraph runs, taking this device's side of every conflict. */
const rebuild = (merge: MergeResult): string => {
  const conflicts = merge.parts.flatMap((part) => (part.kind === 'conflict' ? [part] : []));
  return toParagraphs(merge)
    .map((runs) =>
      runs
        .map((run) =>
          run.kind === 'text' ? run.text : run.kind === 'change' ? run.part.text : conflicts[run.index]?.mine,
        )
        .join(''),
    )
    .join('\n');
};

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
      merged(opening('la gardienne montait'), middle('l’ardoise '), closing('')),
    );
    // Keep both joins the texts exactly as written: no separator is invented.
    expect(resolvedText(resolveAll(state, 'theirs', 'both', { edit: ', effacée' }))).toBe(
      merged(opening('Marthe gravissait'), middle('l’ardoise le vert '), closing(', effacée')),
    );
  });

  it('accepts an empty hand edit, which removes the passage', () => {
    const state = resolveAll(createReconciliation(base, mine, theirs), { edit: '' }, 'theirs', { edit: '' });

    expect(remaining(state)).toBe(0);
    expect(resolvedText(state)).toBe(merged(opening(''), middle('le vert '), closing('')));
  });

  it('resolves a conflict made only of spaces', () => {
    const state = createReconciliation('Il dit oui.', 'Il dit  oui.', 'Il dit\toui.');

    expect(state.conflicts.map((entry) => [entry.part.mine, entry.part.theirs])).toEqual([['  ', '\t']]);
    expect(resolvedText(resolveAll(state, 'both'))).toBe('Il dit  \toui.');
    expect(resolvedText(resolveAll(state, 'theirs'))).toBe('Il dit\toui.');
  });

  it('keeps line breaks inside changes and conflicts', () => {
    const clean = createReconciliation('Un.\nDeux.', 'Un.\nDeux.\n\nTrois.', 'Un, puis.\nDeux.');
    expect(resolvedText(clean)).toBe('Un, puis.\nDeux.\n\nTrois.');

    const state = createReconciliation(
      'Elle dort.\nIl lit.',
      'Elle dort.\n\nIl lit. Fin.',
      'Elle dort. Il lit.\n\nNouveau.',
    );
    expect(state.conflicts.map((entry) => [entry.part.mine, entry.part.theirs])).toEqual([
      ['\n\n', ' '],
      [' Fin.', '\n\nNouveau.'],
    ]);
    expect(resolvedText(resolveAll(state, 'mine', 'both'))).toBe('Elle dort.\n\nIl lit. Fin.\n\nNouveau.');
    expect(rebuild(state.merge)).toBe('Elle dort.\n\nIl lit. Fin.');
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
    expect(resolvedText(state)).toBe(merged(opening('la gardienne montait'), middle('le bleu-gris '), closing('')));
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
    expect(resolvedText(state)).toBe(
      merged(opening('la gardienne montait'), middle('l’ardoise '), closing(', presque effacée par les embruns')),
    );
  });

  it('keeps a later hand edit when an earlier conflict disappears and its index changes', () => {
    let state = resolveConflict(createReconciliation(base, mine, theirs), 1, { edit: 'le bleu-gris ' });
    state = resolveConflict(state, 2, 'theirs');
    state = recompute(state, base, mine, theirs.replace('Marthe gravissait', 'Marthe montait'));

    expect(state.conflicts.map((entry) => entry.resolution)).toEqual([{ edit: 'le bleu-gris ' }, 'theirs']);
    expect(state.conflicts.some((entry) => entry.recheck)).toBe(false);
    expect(state.orphans).toEqual([]);
    expect(state.lostChoices).toBe(0);
    expect(resolvedText(state)).toBe(
      merged(opening('la gardienne montait'), middle('le bleu-gris '), closing(', presque effacée par les embruns')),
    );
  });

  describe('when one conflict splits in two, or two merge into one', () => {
    const chatBase = 'Le chat dort sur la table.';
    const chatMine = 'Le chien dort sur la chaise.';
    const oneConflict = 'Le lion rêve.';
    const twoConflicts = 'Le lion dort sur la nappe.';

    it('turns the hand edit of a conflict that split into an orphan that blocks the confirmation', () => {
      let state = resolveConflict(createReconciliation(chatBase, chatMine, oneConflict), 0, { edit: 'renard court' });
      state = recompute(state, chatBase, chatMine, twoConflicts);

      expect(state.conflicts).toHaveLength(2);
      expect(state.orphans).toEqual(['renard court']);
      state = resolveAll(state, 'mine', 'theirs');
      expect(remaining(state)).toBe(1);
      expect(resolvedText(state)).toBeUndefined();
      expect(resolvedText(dismissOrphan(state, 0))).toBe('Le chien dort sur la nappe.');
    });

    it('turns the hand edits of conflicts that merged into orphans, in order', () => {
      let state = resolveAll(
        createReconciliation(chatBase, chatMine, twoConflicts),
        { edit: 'renard' },
        {
          edit: 'nappe bleue',
        },
      );
      state = recompute(state, chatBase, chatMine, oneConflict);

      expect(state.conflicts).toHaveLength(1);
      expect(state.conflicts[0]?.resolution).toBeUndefined();
      expect(state.orphans).toEqual(['renard', 'nappe bleue']);
      state = resolveConflict(state, 0, 'theirs');
      expect(resolvedText(state)).toBeUndefined();
      expect(resolvedText(dismissOrphan(dismissOrphan(state, 1), 0))).toBe('Le lion rêve.');
    });
  });

  it('turns hand edits into orphans when the base itself changed', () => {
    let state = resolveConflict(createReconciliation(base, mine, theirs), 1, { edit: 'le bleu-gris ' });
    state = recompute(state, `${base} Fin.`, mine, theirs);

    expect(state.orphans).toEqual(['le bleu-gris ']);
    expect(state.conflicts.every((entry) => entry.resolution === undefined)).toBe(true);
  });

  it('splits the merged text into lines that give the text back, conflicts in place', () => {
    const paragraphs = toParagraphs(createReconciliation(base, mine, theirs).merge);
    expect(paragraphs.map((runs) => runs.filter((run) => run.kind === 'conflict').length)).toEqual([1, 0, 1, 0, 1]);

    const merge = createReconciliation(base, mine, theirs).merge;
    expect(rebuild(merge)).toBe(resolveMerge(merge, ['mine', 'mine', 'mine']));
  });

  it('gives the text back exactly from its lines, with CRLF, tabs, blank lines and trailing spaces', () => {
    const awkward = 'Titre  \r\n\r\n\tUn retrait.\nDeux  \n\n\n Fin.\t\n';
    const edited = 'Titre  \r\n\r\n\tUn retrait, modifié.\nDeux  \n\n\n Fin.\t\nAjout.\n';
    expect(rebuild(createReconciliation(awkward, edited, awkward).merge)).toBe(edited);

    const state = createReconciliation(awkward, edited, awkward.replace('Deux', 'Trois'));
    const expected = 'Titre  \r\n\r\n\tUn retrait, modifié.\nTrois  \n\n\n Fin.\t\nAjout.\n';
    expect(state.conflicts).toHaveLength(0);
    expect(rebuild(state.merge)).toBe(expected);
    expect(resolvedText(state)).toBe(expected);
  });

  it('sends the focus after the current conflict first, then back to earlier ones, then to orphans and Confirm', () => {
    let state = createReconciliation(base, mine, theirs);
    expect(nextFocus(state, 0)).toEqual({ conflict: 1 });

    state = resolveConflict(resolveConflict(state, 1, 'mine'), 2, 'mine');
    expect(nextFocus(state, 2)).toEqual({ conflict: 0 });

    state = resolveConflict(state, 0, { edit: 'la gardienne grimpait' });
    expect(nextFocus(state, 0)).toBe('confirm');

    state = recompute(state, base, mine, theirs.replace('Marthe gravissait', 'Marthe grimpait'));
    expect(state.conflicts[0]?.recheck).toBe(true);
    expect(nextFocus(state, 2)).toEqual({ conflict: 0 });

    state = recompute(state, base, mine, theirs.replace('Marthe gravissait', 'Marthe montait'));
    expect(state.orphans).toEqual(['la gardienne grimpait']);
    expect(nextFocus(state, 1)).toEqual({ orphan: 0 });
  });
});
