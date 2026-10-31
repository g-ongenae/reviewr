import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { updateSessionWords } from '../src/sessionWords.ts';

test('counts edits across documents and clamps deletions', () => {
  let total = updateSessionWords(0, '', 'one two');
  total = updateSessionWords(total, 'old words', 'old words plus three');
  assert.equal(total, 4);
  total = updateSessionWords(total, 'old words plus three', 'old');
  assert.equal(total, 1);
  assert.equal(updateSessionWords(total, 'one two three', ''), 0);
});

test('whitespace and edits within a word do not add words', () => {
  assert.equal(updateSessionWords(2, 'hello world', 'hello   worlds'), 2);
});
