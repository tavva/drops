import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { isEmailAllowed } from '@/services/allowlist';

beforeAll(async () => {
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'friend@outside.com' });
});

describe('isEmailAllowed', () => {
  it('allows an email in the table', async () => {
    expect(await isEmailAllowed('friend@outside.com')).toBe(true);
  });
  it('allows an email in the domain', async () => {
    expect(await isEmailAllowed('anyone@example.com')).toBe(true);
  });
  it('rejects neither', async () => {
    expect(await isEmailAllowed('nope@some-other-domain.test')).toBe(false);
  });
  it('is case-insensitive on email', async () => {
    expect(await isEmailAllowed('FRIEND@outside.com')).toBe(true);
  });
});
