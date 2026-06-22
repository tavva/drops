// ABOUTME: canViewByEmail mirrors canView across viewModes for an email with no user id yet.
import { describe, it, expect, beforeEach } from 'vitest';

let ownerId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops); await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  ownerId = u!.id;
});

async function makeDrop(viewMode: string) {
  const { db } = await import('@/db');
  const { drops } = await import('@/db/schema');
  const [d] = await db.insert(drops).values({ ownerId, name: `d-${viewMode}`, viewMode }).returning();
  return d!;
}

describe('canViewByEmail', () => {
  it('owner email always allowed', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('emails');
    expect(await canViewByEmail('alice@example.com', d)).toBe(true);
  });
  it('public: any email', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    expect(await canViewByEmail('stranger@nowhere.com', await makeDrop('public'))).toBe(true);
  });
  it('authed: only member emails', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('authed');
    expect(await canViewByEmail('bob@example.com', d)).toBe(true);     // ALLOWED_DOMAIN
    expect(await canViewByEmail('bob@other.com', d)).toBe(false);
  });
  it('emails: only listed viewers', async () => {
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('emails');
    await db.insert(dropViewers).values({ dropId: d.id, email: 'listed@x.com' });
    expect(await canViewByEmail('listed@x.com', d)).toBe(true);
    expect(await canViewByEmail('unlisted@x.com', d)).toBe(false);
  });
  it('emails + includeDomain: members admitted alongside listed viewers', async () => {
    const { db } = await import('@/db');
    const { drops, dropViewers } = await import('@/db/schema');
    const { canViewByEmail } = await import('@/services/permissions');
    const [d] = await db.insert(drops).values({
      ownerId, name: 'd-emails-domain', viewMode: 'emails', includeDomain: true,
    }).returning();
    await db.insert(dropViewers).values({ dropId: d!.id, email: 'listed@x.com' });
    expect(await canViewByEmail('listed@x.com', d!)).toBe(true);       // listed outsider
    expect(await canViewByEmail('member@example.com', d!)).toBe(true); // domain member via includeDomain
    expect(await canViewByEmail('stranger@other.com', d!)).toBe(false); // neither
  });
});
