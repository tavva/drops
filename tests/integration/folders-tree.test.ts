// ABOUTME: Integration tests for the per-viewer folder tree builder used by the dashboard.
// ABOUTME: Counts reflect only drops visible to the viewer (emails-mode drops hidden from non-listed members).
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { users, drops, dropViewers, folders } from '@/db/schema';
import { createFolder, listFolderTree } from '@/services/folders';

async function resetAll() {
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(folders);
  await db.delete(users);
}

async function insertUser(opts: { email: string; username: string }) {
  const [u] = await db.insert(users).values({ email: opts.email, username: opts.username }).returning();
  return u!;
}

async function insertDrop(opts: { ownerId: string; name: string; viewMode?: 'authed' | 'public' | 'emails'; folderId?: string | null }) {
  const [d] = await db.insert(drops).values({
    ownerId: opts.ownerId,
    name: opts.name,
    viewMode: opts.viewMode ?? 'authed',
    folderId: opts.folderId ?? null,
  }).returning();
  return d!;
}

describe('listFolderTree', () => {
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };
  beforeEach(async () => {
    await resetAll();
    const a = await insertUser({ email: 'alice@x.test', username: 'alice' });
    const b = await insertUser({ email: 'bob@x.test', username: 'bob' });
    alice = { id: a.id, email: 'alice@x.test' };
    bob = { id: b.id, email: 'bob@x.test' };
  });

  it('lists all folders under byId and direct-child ids alphabetically', async () => {
    const work = await createFolder(alice.id, 'work');
    const z = await createFolder(alice.id, 'z-sub', work.id);
    const a = await createFolder(alice.id, 'a-sub', work.id);
    const tree = await listFolderTree(alice);
    expect(tree.byId.size).toBe(3);
    expect(tree.byId.get(work.id)!.childFolderIds).toEqual([a.id, z.id]);
  });

  it('places drops inside their folder, sorted alphabetically', async () => {
    const fa = await createFolder(alice.id, 'work');
    const pub = await insertDrop({ ownerId: alice.id, name: 'zed', viewMode: 'public', folderId: fa.id });
    const early = await insertDrop({ ownerId: alice.id, name: 'alpha', viewMode: 'public', folderId: fa.id });
    const tree = await listFolderTree(alice);
    expect(tree.byId.get(fa.id)!.drops.map((x) => x.id)).toEqual([early.id, pub.id]);
  });

  it('omits drops the viewer cannot see; counts reflect per-viewer totals', async () => {
    const f = await createFolder(alice.id, 'secret');
    const d = await insertDrop({ ownerId: alice.id, name: 'hidden', viewMode: 'emails', folderId: f.id });

    const asAlice = await listFolderTree(alice);
    const asBob = await listFolderTree(bob);
    expect(asAlice.byId.get(f.id)!.visibleDropCount).toBe(1);
    expect(asBob.byId.get(f.id)!.visibleDropCount).toBe(0);
    expect(asBob.byId.get(f.id)!.drops.map((x) => x.id)).not.toContain(d.id);
  });

  it('includes the drop when the viewer is on the emails list', async () => {
    const f = await createFolder(alice.id, 'shared');
    const d = await insertDrop({ ownerId: alice.id, name: 'shared', viewMode: 'emails', folderId: f.id });
    await db.insert(dropViewers).values({ dropId: d.id, email: 'bob@x.test' });
    const asBob = await listFolderTree(bob);
    expect(asBob.byId.get(f.id)!.drops.map((x) => x.id)).toContain(d.id);
  });

  it('returns unfoldered drops as rootDrops, alphabetical', async () => {
    await insertDrop({ ownerId: alice.id, name: 'zz', viewMode: 'public' });
    await insertDrop({ ownerId: alice.id, name: 'aa', viewMode: 'public' });
    const tree = await listFolderTree(alice);
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['aa', 'zz']);
  });

  it('with mineOnly=true, drops restricted to caller; folders still shown', async () => {
    const f = await createFolder(bob.id, 'bobs-work');
    await insertDrop({ ownerId: bob.id, name: 'bob-drop', viewMode: 'public', folderId: f.id });
    await insertDrop({ ownerId: alice.id, name: 'alice-drop', viewMode: 'public' });
    const tree = await listFolderTree(alice, { mineOnly: true });
    expect(tree.byId.has(f.id)).toBe(true);
    expect(tree.byId.get(f.id)!.visibleDropCount).toBe(0);
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['alice-drop']);
  });
});
