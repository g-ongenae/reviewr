import algoan from '@algoan/eslint-config';

export default [
  ...algoan,
  {
    // Tests may import dev dependencies.
    files: ['src/**/*.spec.ts'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      '@typescript-eslint/naming-convention': 'off',
      'jsdoc/require-jsdoc': 'off',
      'no-magic-numbers': 'off',
    },
  },
  {
    // The machine and its spec were moved here unchanged from apps/web, which lints them with lighter rules, so the move
    // can be reviewed as "nothing changed". Only style rules are off: bringing these two files to the house style
    // (braces, blank lines, JSDoc on inner helpers, arrow functions, a default case on an exhaustive switch) is left to
    // its own pull request. `no-bitwise` stays off for good: the text fingerprint (cyrb53) and the spec's seeded random
    // generator are bit arithmetic.
    files: ['src/autosave.ts', 'src/autosave.spec.ts'],
    rules: {
      curly: 'off',
      'default-case': 'off',
      'max-lines': 'off',
      'no-bitwise': 'off',
      'no-magic-numbers': 'off',
      'no-void': 'off',
      'jsdoc/check-indentation': 'off',
      'jsdoc/require-jsdoc': 'off',
      'prefer-arrow/prefer-arrow-functions': 'off',
      '@stylistic/padding-line-between-statements': 'off',
      '@typescript-eslint/method-signature-style': 'off',
      '@typescript-eslint/no-shadow': 'off',
      '@typescript-eslint/promise-function-async': 'off',
    },
  },
];
