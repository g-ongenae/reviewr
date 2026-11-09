import { describe, expect, it } from 'vitest';
import { countCharacterChanges, countCharacters } from './writingStats';

describe('countCharacters', () => {
  it('counts code points, so an emoji or an accented letter is one character', () => {
    expect(countCharacters('')).toBe(0);
    expect(countCharacters('Hello, how are you today?')).toBe(25);
    expect(countCharacters('été 🌊')).toBe(5);
  });
});

describe('countCharacterChanges', () => {
  const changes = (before: string, after: string) => countCharacterChanges(before, after);

  it('counts nothing when the text did not change', () => {
    expect(changes('Once upon a tide.', 'Once upon a tide.')).toEqual({ added: 0, deleted: 0 });
  });

  it('counts a new text as all written, and a cleared one as all deleted', () => {
    expect(changes('', 'Hello')).toEqual({ added: 5, deleted: 0 });
    expect(changes('Hello', '')).toEqual({ added: 0, deleted: 5 });
  });

  it('counts text written at the end or in the middle', () => {
    expect(changes('Once upon a tide.', 'Once upon a tide. The end.')).toEqual({ added: 9, deleted: 0 });
    expect(changes('Once upon a tide.', 'Once upon a high tide.')).toEqual({ added: 5, deleted: 0 });
  });

  it('counts a typo fix as the letters changed, not the whole word', () => {
    expect(changes('The lighthuose keeper', 'The lighthouse keeper')).toEqual({ added: 1, deleted: 1 });
  });

  it('counts each change separately when several paragraphs were edited', () => {
    const before = 'First paragraph.\nSecond paragraph.\nThird paragraph.\n';
    const after = 'First paragraphs.\nSecond paragraph.\nThird, last paragraph.\n';
    expect(changes(before, after)).toEqual({ added: 7, deleted: 0 });
  });

  it('counts a replaced word as deleted and written again, even when it shares a few letters', () => {
    expect(changes('The sea was calm that night.', 'The sky was dark that night.')).toEqual({ added: 7, deleted: 7 });
  });

  it('counts a rewritten sentence as deleted and written again, keeping only the spaces', () => {
    const before = 'The sea was calm that night.';
    const after = 'A storm broke over the harbour.';
    expect(changes(before, after)).toEqual({
      added: countCharacters('Astormbrokeovertheharbour'),
      deleted: countCharacters('Theseawascalmthatnight'),
    });
  });

  it('never splits an emoji in two', () => {
    expect(changes('wave 🌊', 'wave 🌋')).toEqual({ added: 1, deleted: 1 });
  });

  it('always adds up to the change in length, however the text was edited', () => {
    const words = ['la', 'mer', 'était', 'calme', 'ce', 'soir', '.', ',', '\n', ' ', '🌊', 'l’eau'];
    let seed = 42;
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    const text = (length: number) => Array.from({ length }, () => words[random(words.length)]).join(' ');
    for (let run = 0; run < 200; run++) {
      const before = text(random(80));
      const after =
        random(2) === 0 ? text(random(80)) : `${before.slice(0, random(50))}${text(5)}${before.slice(random(60))}`;
      const { added, deleted } = changes(before, after);
      expect(added - deleted).toBe(countCharacters(after) - countCharacters(before));
      expect(added).toBeLessThanOrEqual(countCharacters(after));
      expect(deleted).toBeLessThanOrEqual(countCharacters(before));
    }
  });

  it('stays fast on a long text edited in many places', () => {
    const paragraphs = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}: ${'mot '.repeat(50)}\n`);
    const before = paragraphs.join('');
    const after = paragraphs
      .map((paragraph, i) => (i % 10 === 0 ? paragraph.replace('mot', 'phrase') : paragraph))
      .join('');
    const start = performance.now();
    expect(changes(before, after)).toEqual({ added: 200 * 6, deleted: 200 * 3 });
    expect(performance.now() - start).toBeLessThan(500);
  });
});
