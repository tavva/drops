// ABOUTME: Flat ESLint config using @typescript-eslint recommended rules for TS sources.
// ABOUTME: Ignores compiled output, coverage reports, Playwright artefacts, and generated SQL migrations.
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'src/db/migrations/**',
    ],
  },
  ...tseslint.configs['flat/recommended'],
];
