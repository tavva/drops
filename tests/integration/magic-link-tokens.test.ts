// ABOUTME: magic_link_tokens service — single-use consume and per-(email,drop) send dedupe.
import { describe, it, expect, beforeEach } from 'vitest';

let ownerId: string;
let dropId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, magicLinkTokens } = await import('@/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  ownerId = u!.id;
  const [d] = await db.insert(drops).values({ ownerId, name: 'foo', viewMode: 'emails' }).returning();
  dropId = d!.id;
});

describe('issueMagicToken', () => {
  it('creates a token the first time and reuses it the second', async () => {
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    const a = await issueMagicToken('viewer@x.com', dropId, '/a.html');
    const b = await issueMagicToken('viewer@x.com', dropId, '/b.html');
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);   // same outstanding token reused
  });

  it('normalises the email', async () => {
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    const a = await issueMagicToken('Viewer@X.com', dropId, '/');
    const b = await issueMagicToken('viewer@x.com', dropId, '/');
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);
  });
});

describe('consumeMagicToken', () => {
  it('consumes exactly once', async () => {
    const { issueMagicToken, consumeMagicToken } = await import('@/services/magicLinkTokens');
    const { token } = await issueMagicToken('viewer@x.com', dropId, '/x.html');
    const first = await consumeMagicToken(token);
    expect(first).toMatchObject({ email: 'viewer@x.com', dropId, next: '/x.html' });
    const second = await consumeMagicToken(token);
    expect(second).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const { consumeMagicToken } = await import('@/services/magicLinkTokens');
    expect(await consumeMagicToken('nope')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { consumeMagicToken } = await import('@/services/magicLinkTokens');
    await db.insert(magicLinkTokens).values({
      id: 'expired-tok', email: 'viewer@x.com', dropId, next: '/',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeMagicToken('expired-tok')).toBeNull();
  });
});

describe('issueMagicToken dedupe vs expiry', () => {
  it('an expired outstanding token does not dedupe a new request', async () => {
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    await db.insert(magicLinkTokens).values({
      id: 'stale-tok', email: 'viewer@x.com', dropId, next: '/',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fresh = await issueMagicToken('viewer@x.com', dropId, '/');
    expect(fresh.created).toBe(true);
    expect(fresh.token).not.toBe('stale-tok');
  });
});
