import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.js';

/** Non-breaking space, before `:` `;` `!` `?` and inside `« »` in French. */
const NBSP: string = String.fromCharCode(0x00a0);
/** Narrow non-breaking space, the finer French typographic space. */
const NNBSP: string = String.fromCharCode(0x202f);
/** Combining acute accent, as in a decomposed `é`. */
const ACUTE: string = String.fromCharCode(0x0301);

describe('tokenize', () => {
  it.each([
    ['empty', ''],
    ['plain', 'Le chat dort.'],
    ['LF paragraphs', 'Un.\n\nDeux.\n'],
    ['CRLF paragraphs', 'Un.\r\n\r\nDeux.\r\n'],
    ['old Mac line breaks', 'Un.\rDeux.'],
    ['French typography', `«${NNBSP}Bonjour${NNBSP}», dit-il${NBSP}: «${NBSP}c’est l’heure${NBSP}!${NBSP}»`],
    ['hyphens and dashes', 'Un porte-monnaie — vide – ou presque… Jean‑Pierre'],
    ['emoji', 'Bravo 👍🏽 ! 👩‍👩‍👧 🇫🇷 1️⃣ ❤️'],
    ['combining marks', 'été'.normalize('NFD')],
    ['tabs and trailing spaces', '\tIndenté  \n  fin   '],
    ['lone surrogate', `a${String.fromCharCode(0xd800)}b`],
    ['digits and symbols', 'Le 14 juillet 1789, à 15h30 : 3,5 % de +.'],
  ])('gives back the input exactly: %s', (_name: string, text: string) => {
    expect(tokenize(text).join('')).toBe(text);
  });

  it('keeps French words, typographic spaces and punctuation apart', () => {
    expect(tokenize(`«${NNBSP}Aujourd’hui${NBSP}?${NNBSP}», dit-il.`)).toEqual([
      '«',
      NNBSP,
      'Aujourd’hui',
      NBSP,
      '?',
      NNBSP,
      '»',
      ',',
      ' ',
      'dit-il',
      '.',
    ]);
  });

  it('keeps a CRLF as one line break, separate from the spaces around it', () => {
    expect(tokenize('fin. \r\n\r\nDébut')).toEqual(['fin', '.', ' ', '\r\n', '\r\n', 'Début']);
  });

  it('never splits an emoji', () => {
    const family: string = '👩‍👩‍👧';
    expect(tokenize(`a ${family}👍🏽🇫🇷.`)).toEqual(['a', ' ', family, '👍🏽', '🇫🇷', '.']);
  });

  it('runs on any code point without dropping one', () => {
    let text: string = '';
    for (let code: number = 0; code < 0x3000; code += 7) {
      text += String.fromCharCode(code);
    }
    expect(tokenize(text).join('')).toBe(text);
  });
});
