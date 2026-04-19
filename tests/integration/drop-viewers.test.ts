// ABOUTME: Integration tests for the drop_viewers service (add/remove/list, idempotency, cascade).
// ABOUTME: Runs against the shared test DB; seeds a single owner+drop per test.
import { describe, it, expect } from 'vitest';

async function seedDrop() {
  const { db } = await import('@/db');
  const { users, drops, dropViewers } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops); await db.delete(users);
  const [u] = await db.insert(users).values({
    email: 'o@example.com', username: 'o', kind: 'member',
  }).returning();
  const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 's' }).returning();
  return { userId: u!.id, dropId: d!.id };
}

describe('drop-viewers service', () => {
  it('addViewer + listViewers', async () => {
    const { dropId } = await seedDrop();
    const { addViewer, listViewers } = await import('@/services/dropViewers');
    await addViewer(dropId, 'Alice@Example.org');
    await addViewer(dropId, 'bob@example.org');
    const list = await listViewers(dropId);
    expect(list.map(v => v.email).sort()).toEqual(['alice@example.org', 'bob@example.org']);
  });

  it('addViewer is idempotent (on conflict do nothing)', async () => {
    const { dropId } = await seedDrop();
    const { addViewer, listViewers } = await import('@/services/dropViewers');
    await addViewer(dropId, 'alice@example.org');
    await addViewer(dropId, 'ALICE@example.org');
    expect((await listViewers(dropId)).length).toBe(1);
  });

  it('removeViewer removes the row, returns true on hit, false on miss', async () => {
    const { dropId } = await seedDrop();
    const { addViewer, removeViewer } = await import('@/services/dropViewers');
    await addViewer(dropId, 'alice@example.org');
    expect(await removeViewer(dropId, 'Alice@example.org')).toBe(true);
    expect(await removeViewer(dropId, 'alice@example.org')).toBe(false);
  });

  it('isViewerAllowed matches on normalised email', async () => {
    const { dropId } = await seedDrop();
    const { addViewer, isViewerAllowed } = await import('@/services/dropViewers');
    await addViewer(dropId, 'alice@example.org');
    expect(await isViewerAllowed(dropId, 'ALICE@EXAMPLE.ORG')).toBe(true);
    expect(await isViewerAllowed(dropId, 'nope@example.org')).toBe(false);
  });

  it('viewer rows cascade on drop delete', async () => {
    const { userId, dropId } = await seedDrop();
    const { addViewer } = await import('@/services/dropViewers');
    await addViewer(dropId, 'alice@example.org');
    const { deleteDrop } = await import('@/services/drops');
    expect(await deleteDrop(dropId, userId)).toBe(true);
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    expect((await db.select().from(dropViewers)).length).toBe(0);
  });
});
