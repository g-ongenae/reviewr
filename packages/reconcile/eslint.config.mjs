import algoan from '@algoan/eslint-config';

export default [
  ...algoan,
  {
    // Tests may import dev dependencies.
    files: ['src/**/*.spec.ts', 'src/fixtures.ts'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      '@typescript-eslint/naming-convention': 'off',
      'jsdoc/require-jsdoc': 'off',
      'no-magic-numbers': 'off',
    },
  },
  {
    // The model, the session, their specs and fixtures were moved here unchanged from apps/web, which lints them with
    // lighter rules, so the move can be reviewed as "nothing changed". Bringing these files to the house style (braces,
    // blank lines, JSDoc on inner helpers, arrow functions, method signatures) and the spec's test doubles to the stricter
    // rules (`null`, empty functions, promise-returning functions, one long test) is left to its own pull request.
    // `no-bitwise` stays off for good: the spec's seeded random generator is bit arithmetic.
    files: ['src/reconcile.ts', 'src/session.ts', 'src/reconcile.spec.ts', 'src/session.spec.ts'],
    rules: {
      complexity: 'off',
      curly: 'off',
      'no-bitwise': 'off',
      'no-magic-numbers': 'off',
      'jsdoc/check-indentation': 'off',
      'jsdoc/require-jsdoc': 'off',
      'no-null/no-null': 'off',
      'prefer-arrow/prefer-arrow-functions': 'off',
      '@stylistic/padding-line-between-statements': 'off',
      '@typescript-eslint/method-signature-style': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
    },
  },
];
