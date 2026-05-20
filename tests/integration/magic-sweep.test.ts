// ABOUTME: deleteExpiredMagicTokens removes expired/consumed tokens and leaves live ones intact.
import { describe, it, expect, beforeEach } from 'vitest';

let dropId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, magicLinkTokens } = await import('@/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 'foo', viewMode: 'emails' }).returning();
  dropId = d!.id;
});

describe('deleteExpiredMagicTokens', () => {
  it('deletes expired and consumed tokens but keeps live ones', async () => {
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { deleteExpiredMagicTokens } = await import('@/services/magicLinkTokens');
    await db.insert(magicLinkTokens).values([
      { id: 'live', email: 'g@x.com', dropId, next: '/', expiresAt: new Date(Date.now() + 60_000) },
      { id: 'expired', email: 'g@x.com', dropId, next: '/', expiresAt: new Date(Date.now() - 1000) },
      { id: 'consumed', email: 'g@x.com', dropId, next: '/', consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await deleteExpiredMagicTokens();
    const rows = await db.select().from(magicLinkTokens);
    expect(rows.map((r) => r.id)).toEqual(['live']);
  });
});
