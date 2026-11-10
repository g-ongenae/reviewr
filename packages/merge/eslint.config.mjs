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
];
