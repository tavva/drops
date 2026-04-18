import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { pendingLogins } from '@/db/schema';
import { createPendingLogin, consumePendingLogin, PENDING_TTL_SECONDS } from '@/services/pendingLogins';

beforeEach(async () => { await db.delete(pendingLogins); });

describe('pending logins', () => {
  it('creates and consumes', async () => {
    const id = await createPendingLogin({ email: 'x@y.com', name: 'X', avatarUrl: null });
    const rec = await consumePendingLogin(id);
    expect(rec?.email).toBe('x@y.com');
    expect(await consumePendingLogin(id)).toBeNull();
  });
  it('returns null for expired', async () => {
    const id = await createPendingLogin({ email: 'x@y.com', name: null, avatarUrl: null }, -5);
    expect(await consumePendingLogin(id)).toBeNull();
  });
  it('returns null for unknown id', async () => {
    expect(await consumePendingLogin('nope')).toBeNull();
  });
  it('TTL default is 10 minutes', () => {
    expect(PENDING_TTL_SECONDS).toBe(600);
  });
});
