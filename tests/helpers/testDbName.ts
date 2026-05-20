// ABOUTME: The integration-test database name, read from TEST_DB_NAME (set per run by
// ABOUTME: global-setup and inherited by forked workers) with a fixed fallback for e2e/ad-hoc runs.
export const TEST_DB_NAME = process.env.TEST_DB_NAME || 'drops_test';
