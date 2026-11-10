import { describe, expect, it } from 'vitest';
import { type ConflictResolution, type MergePart, type MergeResult, mergeWords, resolveMerge } from './merge.js';
import { tokenize } from './tokenize.js';

/** Non-breaking space, before `:` `;` `!` `?` and inside `« »` in French. */
const NBSP: string = String.fromCharCode(0x00a0);
/** Narrow non-breaking space. */
const NNBSP: string = String.fromCharCode(0x202f);

type Side = 'base' | 'mine' | 'theirs';

/** A merge result's text as one side wrote it: must give that side's input back. */
const asWrittenBy = (result: MergeResult, side: Side): string =>
  result.parts
    .map((part: MergePart): string => {
      if (part.kind === 'unchanged') {
        return part.text;
      }
      if (part.kind === 'conflict') {
        return part[side];
      }
      const changedBySide: boolean = side !== 'base' && (part.kind === 'both' || part.kind === side);

      return changedBySide ? part.text : part.base;
    })
    .join('');

const resolveAll = (result: MergeResult, resolution: ConflictResolution): string =>
  resolveMerge(
    result,
    Array.from({ length: result.conflicts }, (): ConflictResolution => resolution),
  );

/** Small deterministic PRNG (Park–Miller), so failures can be replayed. */
const random = (seed: number): (() => number) => {
  const modulus: number = 2147483647;
  let state: number = seed % modulus || 1;

  return (): number => {
    state = (state * 48271) % modulus;

    return (state - 1) / (modulus - 1);
  };
};

const vocabulary: string[] = [
  'le',
  'la',
  'chat',
  'fenêtre',
  'aujourd’hui',
  'porte-monnaie',
  'l’homme',
  'dit-il',
  'été',
  'Marie',
  '«',
  '»',
  ',',
  '.',
  '…',
  '!',
  '👍🏽',
];
const separators: string[] = [' ', ' ', ' ', NBSP, NNBSP, '\n', '\n\n', '\r\n'];

/** A random French-looking text of `words` words. */
const randomText = (next: () => number, words: number): string => {
  const pick = (list: readonly string[]): string => list[Math.floor(next() * list.length)] ?? '';
  let text: string = '';
  for (let i: number = 0; i < words; i++) {
    text += (i === 0 ? '' : pick(separators)) + pick(vocabulary);
  }

  return text;
};

/** `text` with `count` random word-level deletions, replacements and insertions. */
const randomEdits = (next: () => number, text: string, count: number): string => {
  const tokens: string[] = tokenize(text);
  for (let i: number = 0; i < count; i++) {
    const at: number = Math.floor(next() * (tokens.length + 1));
    const choice: number = next();
    if (choice < 0.3) {
      tokens.splice(at, 1 + Math.floor(next() * 4));
    } else if (choice < 0.6) {
      tokens.splice(at, 1, randomText(next, 1));
    } else {
      tokens.splice(at, 0, ` ${randomText(next, 1 + Math.floor(next() * 3))}`);
    }
  }

  return tokens.join('');
};

describe('mergeWords fixtures', () => {
  it('applies non-overlapping edits of French prose from both sides', () => {
    const base: string = `Il pleuvait sur Paris. «${NNBSP}Ferme la fenêtre${NBSP}!${NNBSP}», dit-elle.`;
    const mine: string = `Il neigeait sur Paris. «${NNBSP}Ferme la fenêtre${NBSP}!${NNBSP}», dit-elle.`;
    const theirs: string = `Il pleuvait sur Paris. «${NNBSP}Ferme la fenêtre${NBSP}!${NNBSP}», murmura-t-elle.`;
    const result: MergeResult = mergeWords(base, mine, theirs);

    expect(result.conflicts).toBe(0);
    expect(result.parts).toEqual([
      { kind: 'unchanged', text: 'Il ' },
      { kind: 'mine', base: 'pleuvait', text: 'neigeait' },
      { kind: 'unchanged', text: ` sur Paris. «${NNBSP}Ferme la fenêtre${NBSP}!${NNBSP}», ` },
      { kind: 'theirs', base: 'dit-elle', text: 'murmura-t-elle' },
      { kind: 'unchanged', text: '.' },
    ]);
    expect(resolveMerge(result, [])).toBe(
      `Il neigeait sur Paris. «${NNBSP}Ferme la fenêtre${NBSP}!${NNBSP}», murmura-t-elle.`,
    );
  });

  it('keeps an apostrophe word whole', () => {
    const result: MergeResult = mergeWords('C’est aujourd’hui.', 'C’est demain.', 'Ce n’est pas aujourd’hui.');

    expect(result.parts).toEqual([
      { kind: 'conflict', base: 'C’est aujourd’hui', mine: 'C’est demain', theirs: 'Ce n’est pas aujourd’hui' },
      { kind: 'unchanged', text: '.' },
    ]);
  });

  it('makes overlapping edits a conflict', () => {
    const result: MergeResult = mergeWords(
      'Marie ouvrit la fenêtre en grand.',
      'Marie ouvrit la porte en grand.',
      'Marie ouvrit la lucarne en grand.',
    );

    expect(result.conflicts).toBe(1);
    expect(result.parts).toEqual([
      { kind: 'unchanged', text: 'Marie ouvrit la ' },
      { kind: 'conflict', base: 'fenêtre', mine: 'porte', theirs: 'lucarne' },
      { kind: 'unchanged', text: ' en grand.' },
    ]);
    expect(resolveAll(result, 'mine')).toBe('Marie ouvrit la porte en grand.');
    expect(resolveAll(result, 'theirs')).toBe('Marie ouvrit la lucarne en grand.');
    expect(resolveAll(result, 'both')).toBe('Marie ouvrit la portelucarne en grand.');
    expect(resolveAll(result, { edit: 'baie vitrée' })).toBe('Marie ouvrit la baie vitrée en grand.');
  });

  it('applies the same edit made on both sides once', () => {
    const result: MergeResult = mergeWords('Il était une fois.', 'Il était deux fois.', 'Il était deux fois.');

    expect(result.parts).toEqual([
      { kind: 'unchanged', text: 'Il était ' },
      { kind: 'both', base: 'une', text: 'deux' },
      { kind: 'unchanged', text: ' fois.' },
    ]);
  });

  describe('adjacent edits are conflicts', () => {
    it.each<[string, string, string, string, MergePart]>([
      [
        'neighbouring words',
        'Elle ouvrit la fenêtre.',
        'Elle ouvrit une fenêtre.',
        'Elle ouvrit la porte.',
        { kind: 'conflict', base: 'la fenêtre', mine: 'une fenêtre', theirs: 'la porte' },
      ],
      [
        'a word and the punctuation touching it',
        'Elle ouvrit la fenêtre.',
        'Elle ouvrit la porte.',
        'Elle ouvrit la fenêtre…',
        { kind: 'conflict', base: 'fenêtre.', mine: 'porte.', theirs: 'fenêtre…' },
      ],
      [
        'an insertion next to a replaced word',
        'Il est grand.',
        'Il est très grand.',
        'Il est petit.',
        { kind: 'conflict', base: 'grand', mine: 'très grand', theirs: 'petit' },
      ],
    ])('%s', (_name: string, base: string, mine: string, theirs: string, conflict: MergePart) => {
      const result: MergeResult = mergeWords(base, mine, theirs);

      expect(result.conflicts).toBe(1);
      expect(result.parts).toContainEqual(conflict);
      expect(resolveAll(result, 'mine')).toBe(mine);
      expect(resolveAll(result, 'theirs')).toBe(theirs);
    });

    it('but edits separated by a punctuation mark or another word merge', () => {
      const result: MergeResult = mergeWords(
        'Il pleuvait, Marie dormait.',
        'Il neigeait, Marie dormait.',
        'Il pleuvait, Marie rêvait.',
      );

      expect(result.conflicts).toBe(0);
      expect(resolveMerge(result, [])).toBe('Il neigeait, Marie rêvait.');
    });
  });

  it('makes a deletion on one side with an edit inside it on the other a conflict', () => {
    const base: string = 'Il pleuvait. Marie dormait encore. Le jour se levait.';
    const mine: string = 'Il pleuvait. Le jour se levait.';
    const theirs: string = 'Il pleuvait. Marie rêvait encore. Le jour se levait.';
    const result: MergeResult = mergeWords(base, mine, theirs);

    expect(result.conflicts).toBe(1);
    expect(result.parts).toEqual([
      { kind: 'unchanged', text: 'Il pleuvait. ' },
      { kind: 'conflict', base: 'Marie dormait encore. ', mine: '', theirs: 'Marie rêvait encore. ' },
      { kind: 'unchanged', text: 'Le jour se levait.' },
    ]);
    expect(resolveAll(result, 'mine')).toBe(mine);
    expect(resolveAll(result, 'theirs')).toBe(theirs);
  });

  it('makes two insertions at the same place a conflict, kept one after the other with "both"', () => {
    const base: string = 'Premier paragraphe.\n';
    const result: MergeResult = mergeWords(base, `${base}Écrit hors ligne.\n`, `${base}Écrit sur le web.\n`);

    expect(result.parts).toEqual([
      { kind: 'unchanged', text: base },
      { kind: 'conflict', base: '', mine: 'Écrit hors ligne.\n', theirs: 'Écrit sur le web.\n' },
    ]);
    expect(resolveAll(result, 'both')).toBe(`${base}Écrit hors ligne.\nÉcrit sur le web.\n`);
  });

  it('applies edits at the very start and the very end', () => {
    const result: MergeResult = mergeWords(
      'Le chat dort sur le tapis',
      'Un chat dort sur le tapis',
      'Le chat dort sur le canapé',
    );

    expect(result.parts).toEqual([
      { kind: 'mine', base: 'Le', text: 'Un' },
      { kind: 'unchanged', text: ' chat dort sur le ' },
      { kind: 'theirs', base: 'tapis', text: 'canapé' },
    ]);
  });

  describe('empty base', () => {
    it('takes the only side that wrote something', () => {
      expect(resolveMerge(mergeWords('', 'Bonjour.', ''), [])).toBe('Bonjour.');
      expect(resolveMerge(mergeWords('', '', 'Bonjour.'), [])).toBe('Bonjour.');
    });

    it('makes two different texts one conflict', () => {
      expect(mergeWords('', 'Bonjour.', 'Salut.').parts).toEqual([
        { kind: 'conflict', base: '', mine: 'Bonjour.', theirs: 'Salut.' },
      ]);
    });

    it('gives an empty result for three empty texts', () => {
      expect(mergeWords('', '', '')).toEqual({ parts: [], conflicts: 0 });
    });
  });

  describe('whitespace and paragraph breaks', () => {
    it('merges a typographic space fix with an edit elsewhere', () => {
      const base: string = 'Quelle heure est-il ? Il est tard.';
      const mine: string = `Quelle heure est-il${NBSP}? Il est tard.`;
      const theirs: string = 'Quelle heure est-il ? Il est très tard.';
      const result: MergeResult = mergeWords(base, mine, theirs);

      expect(result.conflicts).toBe(0);
      expect(result.parts).toContainEqual({ kind: 'mine', base: ' ', text: NBSP });
      expect(resolveMerge(result, [])).toBe(`Quelle heure est-il${NBSP}? Il est très tard.`);
    });

    it('merges a paragraph split with an edit in another sentence', () => {
      const base: string = 'Il pleuvait. Marie dormait.\n\nLe jour se levait.';
      const mine: string = 'Il pleuvait.\n\nMarie dormait.\n\nLe jour se levait.';
      const theirs: string = 'Il pleuvait. Marie dormait.\n\nLe jour se levait à peine.';
      const result: MergeResult = mergeWords(base, mine, theirs);

      expect(result.conflicts).toBe(0);
      expect(result.parts).toContainEqual({ kind: 'mine', base: ' ', text: '\n\n' });
      expect(resolveMerge(result, [])).toBe('Il pleuvait.\n\nMarie dormait.\n\nLe jour se levait à peine.');
    });

    it('merges a joined paragraph with an edit in a paragraph it does not touch', () => {
      const base: string = 'Un.\n\nDeux.\n\nTrois.';
      const result: MergeResult = mergeWords(base, 'Un. Deux.\n\nTrois.', 'Un.\n\nDeux.\n\nTrois et quatre.');

      expect(resolveMerge(result, [])).toBe('Un. Deux.\n\nTrois et quatre.');
    });

    it('keeps CRLF line breaks intact', () => {
      const base: string = 'Un.\r\n\r\nDeux.\r\n';
      const result: MergeResult = mergeWords(base, 'Un !\r\n\r\nDeux.\r\n', 'Un.\r\n\r\nDeux et trois.\r\n');

      expect(resolveMerge(result, [])).toBe('Un !\r\n\r\nDeux et trois.\r\n');
    });

    it('makes a whitespace-only change one side and a word change touching it the other a conflict', () => {
      const result: MergeResult = mergeWords('le  chat', 'le chat', 'le  chien');

      expect(result.parts).toEqual([
        { kind: 'unchanged', text: 'le' },
        { kind: 'conflict', base: '  chat', mine: ' chat', theirs: '  chien' },
      ]);
    });
  });

  describe('repeated text', () => {
    it.each<[string, string, string, string]>([
      ['a deleted line', 'Elle attend.\nElle attend.\n', 'Elle attend.\n', 'Elle part.\nElle attend.\n'],
      ['a deleted sentence', 'Oui. Oui.', 'Oui.', 'Non. Oui.'],
      ['an inserted duplicate line', 'Elle attend.\n', 'Elle attend.\nElle attend.\n', 'Elle part.\n'],
      ['an inserted duplicate sentence', 'Oui.', 'Oui. Oui.', 'Non.'],
    ])(
      'makes %s and an edit of its twin a conflict, whichever side wrote what',
      (_name: string, base: string, slid: string, edited: string) => {
        for (const [mine, theirs] of [
          [slid, edited],
          [edited, slid],
        ] as const) {
          const result: MergeResult = mergeWords(base, mine, theirs);

          expect(result.conflicts).toBe(1);
          expect(resolveAll(result, 'mine')).toBe(mine);
          expect(resolveAll(result, 'theirs')).toBe(theirs);
        }
      },
    );

    it('still merges a deleted duplicate with an edit elsewhere', () => {
      const base: string = 'Elle attend.\nElle attend.\nIl pleut.\n\nLe jour se lève.\n';
      const result: MergeResult = mergeWords(
        base,
        'Elle attend.\nIl pleut.\n\nLe jour se lève.\n',
        'Elle attend.\nElle attend.\nIl pleut.\n\nLe jour se couche.\n',
      );

      expect(result.conflicts).toBe(0);
      expect(resolveMerge(result, [])).toBe('Elle attend.\nIl pleut.\n\nLe jour se couche.\n');
    });

    it('still merges a deleted duplicate word with an edit in another sentence', () => {
      const result: MergeResult = mergeWords('Oui oui. Il pleut.', 'Oui. Il pleut.', 'Oui oui. Il neige.');

      expect(resolveMerge(result, [])).toBe('Oui. Il neige.');
    });
  });

  it('keeps emoji whole', () => {
    const result: MergeResult = mergeWords('Bravo 👍🏽 ! Merci', 'Bravo 👍🏿 ! Merci', 'Bravo 👍🏽 ! Merci beaucoup');

    expect(resolveMerge(result, [])).toBe('Bravo 👍🏿 ! Merci beaucoup');
    expect(result.parts).toContainEqual({ kind: 'mine', base: '👍🏽', text: '👍🏿' });
  });
});

describe('resolveMerge', () => {
  it('keeps the other side’s non-conflicting changes whatever the resolution', () => {
    const result: MergeResult = mergeWords(
      'Il pleuvait. Marie dormait. Le jour se levait.',
      'Il neigeait. Marie dormait. Le soleil se levait.',
      'Il pleuvait. Marie rêvait. Le matin se levait.',
    );

    expect(result.conflicts).toBe(1);
    expect(resolveAll(result, 'mine')).toBe('Il neigeait. Marie rêvait. Le soleil se levait.');
    expect(resolveAll(result, 'theirs')).toBe('Il neigeait. Marie rêvait. Le matin se levait.');
  });

  it('applies one resolution per conflict, in order', () => {
    const result: MergeResult = mergeWords('a. b. c.', 'x. b. y.', 'z. b. w.');

    expect(result.conflicts).toBe(2);
    expect(resolveMerge(result, ['mine', 'theirs'])).toBe('x. b. w.');
    expect(resolveMerge(result, [{ edit: 'q' }, 'both'])).toBe('q. b. yw.');
  });

  it('refuses a wrong number of resolutions', () => {
    const result: MergeResult = mergeWords('a. b.', 'x. b.', 'z. b.');

    expect(() => resolveMerge(result, [])).toThrow(RangeError);
    expect(() => resolveMerge(result, ['mine', 'mine'])).toThrow(RangeError);
  });
});

describe('mergeWords properties', () => {
  const cases: [number, string, string, string][] = Array.from({ length: 300 }, (_: unknown, seed: number) => {
    const next: () => number = random(seed + 1);
    const base: string = randomText(next, Math.floor(next() * 60));
    const mine: string = next() < 0.15 ? base : randomEdits(next, base, Math.floor(next() * 6));
    const theirs: string = next() < 0.15 ? base : next() < 0.1 ? mine : randomEdits(next, base, Math.floor(next() * 6));

    return [seed, base, mine, theirs];
  });

  it.each(cases)('holds for random edits, seed %i', (_seed: number, base: string, mine: string, theirs: string) => {
    const result: MergeResult = mergeWords(base, mine, theirs);

    // Deterministic.
    expect(mergeWords(base, mine, theirs)).toEqual(result);

    // The parts are an exact alignment of the three inputs.
    expect(asWrittenBy(result, 'base')).toBe(base);
    expect(asWrittenBy(result, 'mine')).toBe(mine);
    expect(asWrittenBy(result, 'theirs')).toBe(theirs);
    expect(result.conflicts).toBe(result.parts.filter((part: MergePart): boolean => part.kind === 'conflict').length);

    // Trivial merges never conflict.
    if (mine === base || theirs === base || mine === theirs) {
      expect(result.conflicts).toBe(0);
      expect(resolveMerge(result, [])).toBe(mine === base ? theirs : mine);
    }

    // Resolving every conflict one way keeps all non-conflicting changes of both sides.
    for (const resolution of ['mine', 'theirs', 'both'] as const) {
      const expected: string = result.parts
        .map((part: MergePart): string => {
          if (part.kind !== 'conflict') {
            return part.text;
          }

          return resolution === 'both' ? part.mine + part.theirs : part[resolution];
        })
        .join('');
      const resolved: string = resolveAll(result, resolution);
      expect(resolved).toBe(expected);
      if (resolution === 'both') {
        continue; // Mine and theirs side by side may join into a new word, as the writer asked.
      }

      // No token in the output that is in none of the inputs.
      const known: Set<string> = new Set([...tokenize(base), ...tokenize(mine), ...tokenize(theirs)]);
      expect(tokenize(resolved).filter((token: string): boolean => !known.has(token))).toEqual([]);
    }
  });
});

describe('mergeWords performance', () => {
  const next: () => number = random(42);
  const chapter: string = Array.from({ length: 200 }, (): string => randomText(next, 100)).join('\n\n');

  /** Run a merge and return how long it took, in milliseconds. */
  const time = (base: string, mine: string, theirs: string): number => {
    const start: number = Date.now();
    const result: MergeResult = mergeWords(base, mine, theirs);
    const elapsed: number = Date.now() - start;
    expect(asWrittenBy(result, 'mine')).toBe(mine);
    expect(asWrittenBy(result, 'theirs')).toBe(theirs);

    return elapsed;
  };

  it('merges a 20,000-word chapter with scattered edits quickly', () => {
    expect(time(chapter, randomEdits(next, chapter, 100), randomEdits(next, chapter, 100))).toBeLessThan(1000);
  });

  it('merges a 20,000-word single paragraph with scattered edits quickly', () => {
    const paragraph: string = chapter.replace(/\s+/gu, ' ');
    expect(time(paragraph, randomEdits(next, paragraph, 100), randomEdits(next, paragraph, 100))).toBeLessThan(1000);
  });

  it('stays bounded when one side rewrote everything', () => {
    const rewritten: string = randomText(random(7), 20000).replace(/\s+/gu, ' ');
    const paragraph: string = chapter.replace(/\s+/gu, ' ');
    expect(time(paragraph, rewritten, randomEdits(next, paragraph, 100))).toBeLessThan(2000);
  });
});
