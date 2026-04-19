// ABOUTME: Integration tests for canView across the {owner, member, viewer} × {authed, public, emails} matrix.
// ABOUTME: Exercises the function directly — route-level coverage lives in content-serve.test.ts.
import { describe, it, expect } from 'vitest';

async function setup() {
  const { db } = await import('@/db');
  const { users, drops, dropViewers, allowedEmails } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops);
  await db.delete(users); await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'member@allowed.test' });
  const [owner] = await db.insert(users).values({
    email: 'owner@example.com', username: 'o', kind: 'member',
  }).returning();
  const [member] = await db.insert(users).values({
    email: 'member@allowed.test', username: 'm', kind: 'member',
  }).returning();
  const [viewer] = await db.insert(users).values({
    email: 'viewer@out.test', kind: 'viewer',
  }).returning();
  const [d] = await db.insert(drops).values({
    ownerId: owner!.id, name: 's', viewMode: 'authed',
  }).returning();
  return { owner: owner!, member: member!, viewer: viewer!, drop: d! };
}

describe('canView', () => {
  it('owner can always view', async () => {
    const s = await setup();
    const { canView, setViewMode } = await import('@/services/permissions');
    await setViewMode(s.drop.id, 'emails');
    const reloaded = { ...s.drop, viewMode: 'emails' as const };
    expect(await canView(s.owner, reloaded)).toBe(true);
  });

  it('public mode admits everyone', async () => {
    const s = await setup();
    const { canView } = await import('@/services/permissions');
    const d = { ...s.drop, viewMode: 'public' as const };
    expect(await canView(s.viewer, d)).toBe(true);
    expect(await canView(s.member, d)).toBe(true);
  });

  it('authed mode admits members, rejects viewers', async () => {
    const s = await setup();
    const { canView } = await import('@/services/permissions');
    expect(await canView(s.member, s.drop)).toBe(true);
    expect(await canView(s.viewer, s.drop)).toBe(false);
  });

  it('emails mode admits only listed users', async () => {
    const s = await setup();
    const { canView, setViewMode } = await import('@/services/permissions');
    const { addViewer } = await import('@/services/dropViewers');
    await setViewMode(s.drop.id, 'emails');
    await addViewer(s.drop.id, s.viewer.email);
    const d = { ...s.drop, viewMode: 'emails' as const };
    expect(await canView(s.viewer, d)).toBe(true);
    expect(await canView(s.member, d)).toBe(false);
  });
});
