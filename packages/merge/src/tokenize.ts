/**
 * One token of prose. In order of preference:
 *
 * - a line break (`\r\n` is one token, so a CRLF is never cut in half);
 * - a run of other whitespace (spaces, tabs, U+00A0, U+202F…);
 * - a word: letters, digits and combining marks, joined by inner apostrophes and hyphens (`aujourd’hui`, `l’homme`
 * and `porte-monnaie` are one token each);
 * - a pair of regional indicators (a flag emoji);
 * - any other character (punctuation such as `«`, `»`, `…` or `—`, a symbol, an emoji), with the combining marks,
 * variation selectors, skin tones and zero-width-joined characters that follow it, so an emoji is never split;
 * - as a last resort, a lone code point, so that nothing is ever dropped.
 *
 * Uses only the `u` flag and General_Category property escapes (`\p{L}`, `\p{N}`, `\p{M}`), which Hermes supports; no
 * lookbehind and no `Intl.Segmenter`.
 */
const tokenPattern: RegExp =
  /\r\n|[\n\r\u2028\u2029]|[^\S\n\r\u2028\u2029]+|[\p{L}\p{N}\p{M}]+(?:['\u2019\u2010\u2011-][\p{L}\p{N}\p{M}]+)*|[\u{1F1E6}-\u{1F1FF}]{2}|[^\s\p{L}\p{N}\p{M}][\p{M}\u{1F3FB}-\u{1F3FF}]*(?:\u200D[^\s][\p{M}\u{1F3FB}-\u{1F3FF}]*)*|[\s\S]/gu;

const lineBreak: RegExp = /^(?:\r\n|[\n\r\u2028\u2029])$/u;
const inlineSpace: RegExp = /^[^\S\n\r\u2028\u2029]+$/u;

/**
 * Split a text into words, whitespace runs, line breaks and punctuation. Joining the tokens gives the text back exactly.
 */
export const tokenize = (text: string): string[] => text.match(tokenPattern) ?? [];

/**
 * Whether a token is a line break.
 */
export const isLineBreak = (token: string): boolean => lineBreak.test(token);

/**
 * Whether a token is whitespace inside a line (not a line break).
 */
export const isInlineSpace = (token: string): boolean => inlineSpace.test(token);
