import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    setupFiles: ['tests/helpers/env.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
});
