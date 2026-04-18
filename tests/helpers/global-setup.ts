// ABOUTME: Vitest global-setup hook that rebuilds the test database once per run.
import { setupTestDatabase } from './db';
export default async function globalSetup() { await setupTestDatabase(); }
