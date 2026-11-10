import { describe, expect, it } from 'vitest';
import { type MergeResult, mergeWords, resolveMerge } from './merge.js';

/*
 * These tests build mine and theirs from known paragraph edits, and compute the expected merge from those edits, not
 * from the package's own alignment.
 */

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
  ',',
  '.',
  '…',
  '!',
];

describe('mergeWords against edits known by construction', () => {
  /** A line of `words` random words separated by plain spaces. */
  const randomLine = (next: () => number, words: number): string =>
    Array.from({ length: words }, (): string => vocabulary[Math.floor(next() * vocabulary.length)] ?? '').join(' ');

  /** Paragraphs of 4 to 10 words, joined by blank lines. */
  const randomParagraphs = (next: () => number, count: number): string[] =>
    Array.from({ length: count }, (): string => randomLine(next, 4 + Math.floor(next() * 7)));

  /** Rewrite paragraph `index`, or delete it (undefined). */
  const edit = (paragraphs: readonly string[], changes: ReadonlyMap<number, string | undefined>): string =>
    paragraphs
      .flatMap((paragraph: string, index: number): string[] => {
        if (!changes.has(index)) {
          return [paragraph];
        }
        const replacement: string | undefined = changes.get(index);

        return replacement === undefined ? [] : [replacement];
      })
      .join('\n\n');

  const change = (next: () => number): string | undefined => (next() < 0.3 ? undefined : randomLine(next, 5));

  it.each(Array.from({ length: 100 }, (_: unknown, seed: number): number => seed))(
    'merges edits of paragraphs far apart, seed %i',
    (seed: number) => {
      const next: () => number = random(seed + 1000);
      const paragraphs: string[] = randomParagraphs(next, 8);
      // Mine edits even paragraphs below 4, theirs some from 5 on: at least one untouched paragraph in between.
      const mine: Map<number, string | undefined> = new Map([[2 * Math.floor(next() * 2), change(next)]]);
      const theirs: Map<number, string | undefined> = new Map([[5 + Math.floor(next() * 3), change(next)]]);
      const both: Map<number, string | undefined> = new Map([...mine, ...theirs]);
      const result: MergeResult = mergeWords(paragraphs.join('\n\n'), edit(paragraphs, mine), edit(paragraphs, theirs));

      expect(result.conflicts).toBe(0);
      expect(resolveMerge(result, [])).toBe(edit(paragraphs, both));
    },
  );

  it.each(Array.from({ length: 100 }, (_: unknown, seed: number): number => seed))(
    'never silently merges a deleted duplicate paragraph with an edit of its twin, seed %i',
    (seed: number) => {
      const next: () => number = random(seed + 2000);
      const paragraphs: string[] = randomParagraphs(next, 6);
      const twin: number = 1 + Math.floor(next() * 3);
      paragraphs[twin + 1] = paragraphs[twin] ?? '';
      const deleted: number = twin + Math.floor(next() * 2);
      const edited: number = twin + Math.floor(next() * 2);
      const mine: string = edit(paragraphs, new Map([[deleted, undefined]]));
      const theirs: string = edit(paragraphs, new Map([[edited, `${paragraphs[edited] ?? ''} encore`]]));

      expect(mergeWords(paragraphs.join('\n\n'), mine, theirs).conflicts).toBeGreaterThan(0);
      expect(mergeWords(paragraphs.join('\n\n'), theirs, mine).conflicts).toBeGreaterThan(0);
    },
  );

  it.each(Array.from({ length: 200 }, (_: unknown, seed: number): number => seed))(
    'never silently merges a deleted copy among identical sentences with an edit of another copy, seed %i',
    (seed: number) => {
      const next: () => number = random(seed + 3000);
      const copies: number = 2 + Math.floor(next() * 4);
      const copy: string = randomLine(next, 1 + Math.floor(next() * 3));
      const separator: string = ['. ', '.\n', ', ', '.\n\n'][Math.floor(next() * 4)] ?? '. ';
      const sentences: string[] = [
        randomLine(next, 3),
        ...Array.from({ length: copies }, (): string => copy),
        randomLine(next, 3),
      ];
      const join = (list: readonly string[]): string => list.join(separator);
      const pick = (): number => 1 + Math.floor(next() * copies);
      // Mine deletes one copy and, half the time, also rewrites another copy or the next sentence.
      const deleted: number = pick();
      const mineSentences: (string | undefined)[] = [...sentences];
      if (next() < 0.5) {
        const nearby: number = Math.min(deleted + 1 + Math.floor(next() * 2), sentences.length - 1);
        mineSentences[nearby] = 'Non';
      }
      mineSentences[deleted] = undefined;
      const theirsSentences: string[] = [...sentences];
      theirsSentences[pick()] = 'Si';
      const mine: string = join(mineSentences.filter((item: string | undefined): item is string => item !== undefined));
      const theirs: string = join(theirsSentences);

      expect(mergeWords(join(sentences), mine, theirs).conflicts).toBeGreaterThan(0);
      expect(mergeWords(join(sentences), theirs, mine).conflicts).toBeGreaterThan(0);
    },
  );
});
