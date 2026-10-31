import { countWords } from './format.ts';

/** Direct content edits contribute their change in word count; never go below zero. */
export const updateSessionWords = (total: number, before: string, after: string): number =>
  Math.max(0, total + countWords(after) - countWords(before));
