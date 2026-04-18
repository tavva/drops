import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { resetBucket } from '../helpers/r2';

beforeAll(async () => { await resetBucket(); });

describe('helpers', () => {
  it('talks to Postgres', async () => {
    const rows = await db.select().from(allowedEmails);
    expect(rows.some((r) => r.email === 'ben@ben-phillips.net')).toBe(true);
  });
});
