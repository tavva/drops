import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { resetBucket } from '../helpers/r2';

beforeAll(async () => {
  await resetBucket();
  await db.insert(allowedEmails).values({ email: 'alice@example.com' }).onConflictDoNothing();
});

describe('helpers', () => {
  it('talks to Postgres', async () => {
    const rows = await db.select().from(allowedEmails);
    expect(rows.some((r) => r.email === 'alice@example.com')).toBe(true);
  });
});
