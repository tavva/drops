import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
  resolve: {
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
});
