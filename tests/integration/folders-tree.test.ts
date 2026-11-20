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

async function insertDrop(opts: {
  ownerId: string; name: string; viewMode?: 'authed' | 'public' | 'emails'; folderId?: string | null; createdAt?: Date;
}) {
  const [d] = await db.insert(drops).values({
    ownerId: opts.ownerId,
    name: opts.name,
    viewMode: opts.viewMode ?? 'authed',
    folderId: opts.folderId ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
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

  it('with sort=name, places drops inside their folder, sorted alphabetically', async () => {
    const fa = await createFolder(alice.id, 'work');
    const pub = await insertDrop({ ownerId: alice.id, name: 'zed', viewMode: 'public', folderId: fa.id });
    const early = await insertDrop({ ownerId: alice.id, name: 'alpha', viewMode: 'public', folderId: fa.id });
    const tree = await listFolderTree(alice, { sort: 'name' });
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

  it('with sort=name, returns unfoldered drops as rootDrops, alphabetical', async () => {
    await insertDrop({ ownerId: alice.id, name: 'zz', viewMode: 'public' });
    await insertDrop({ ownerId: alice.id, name: 'aa', viewMode: 'public' });
    const tree = await listFolderTree(alice, { sort: 'name' });
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['aa', 'zz']);
  });

  it('by default lists drops newest created first, at the root and inside folders', async () => {
    const f = await createFolder(alice.id, 'work');
    await insertDrop({ ownerId: alice.id, name: 'aa-old', viewMode: 'public', createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertDrop({ ownerId: alice.id, name: 'zz-new', viewMode: 'public', createdAt: new Date('2026-03-01T00:00:00Z') });
    await insertDrop({ ownerId: alice.id, name: 'mm-mid', viewMode: 'public', createdAt: new Date('2026-02-01T00:00:00Z') });
    await insertDrop({ ownerId: alice.id, name: 'in-old', viewMode: 'public', folderId: f.id, createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertDrop({ ownerId: alice.id, name: 'in-new', viewMode: 'public', folderId: f.id, createdAt: new Date('2026-03-01T00:00:00Z') });
    const tree = await listFolderTree(alice);
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['zz-new', 'mm-mid', 'aa-old']);
    expect(tree.byId.get(f.id)!.drops.map((x) => x.name)).toEqual(['in-new', 'in-old']);
  });

  it('keeps folders A–Z whatever the drop sort', async () => {
    const z = await createFolder(alice.id, 'zebra');
    const a = await createFolder(alice.id, 'aardvark');
    expect((await listFolderTree(alice)).rootFolderIds).toEqual([a.id, z.id]);
    expect((await listFolderTree(alice, { sort: 'name' })).rootFolderIds).toEqual([a.id, z.id]);
  });

  it('breaks created-date ties A–Z', async () => {
    const same = new Date('2026-01-01T00:00:00Z');
    await insertDrop({ ownerId: alice.id, name: 'beta', viewMode: 'public', createdAt: same });
    await insertDrop({ ownerId: alice.id, name: 'alpha', viewMode: 'public', createdAt: same });
    const tree = await listFolderTree(alice);
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['alpha', 'beta']);
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
