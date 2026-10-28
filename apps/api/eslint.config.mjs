import algoan from '@algoan/eslint-config';

export default [
  ...algoan,
  {
    rules: {
      // NestJS modules are empty classes carrying a @Module() decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // Tests and tooling configs may import dev dependencies.
    files: ['test/**/*.ts', '*.config.ts'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      '@typescript-eslint/naming-convention': 'off',
      'jsdoc/require-jsdoc': 'off',
      'no-magic-numbers': 'off',
    },
  },
];
