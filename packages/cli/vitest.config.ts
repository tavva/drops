// ABOUTME: Configures the standalone Drops CLI unit test suite.
// ABOUTME: Keeps CLI tests independent from the server integration-test environment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
