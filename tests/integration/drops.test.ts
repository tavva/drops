import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { drops, dropVersions, users } from '@/db/schema';
import { dropViewers } from '@/db/schema';
import {
  createDropAndVersion,
  replaceVersion,
  findByOwnerAndName,
  listByOwner,
  listAllVisible,
  listAllVisibleUnpaged,
  deleteDrop,
  DropConflictError,
} from '@/services/drops';

let ownerA: string;
let ownerB: string;

beforeEach(async () => {
  await db.delete(drops);
  await db.delete(users);
  const [a] = await db.insert(users).values({ email: 'a@x.com', username: 'alice' }).returning();
  const [b] = await db.insert(users).values({ email: 'b@x.com', username: 'bob' }).returning();
  ownerA = a!.id; ownerB = b!.id;
});

describe('drops service', () => {
  it('creates a drop and its first version', async () => {
    const { dropId, versionId } = await createDropAndVersion(ownerA, 'site', {
      r2Prefix: `drops/v1/`, byteSize: 123, fileCount: 2,
    });
    const row = await findByOwnerAndName(ownerA, 'site');
    expect(row?.id).toBe(dropId);
    expect(row?.currentVersion).toBe(versionId);
    expect(row?.version?.byteSize).toBe(123);
  });

  it('lets different owners use the same drop name', async () => {
    await createDropAndVersion(ownerA, 'site', { r2Prefix: 'drops/x/', byteSize: 1, fileCount: 1 });
    await createDropAndVersion(ownerB, 'site', { r2Prefix: 'drops/y/', byteSize: 1, fileCount: 1 });
    expect((await findByOwnerAndName(ownerA, 'site'))?.ownerId).toBe(ownerA);
    expect((await findByOwnerAndName(ownerB, 'site'))?.ownerId).toBe(ownerB);
  });

  it('rejects duplicate name for same owner', async () => {
    await createDropAndVersion(ownerA, 'site', { r2Prefix: 'drops/a/', byteSize: 1, fileCount: 1 });
    await expect(createDropAndVersion(ownerA, 'site', { r2Prefix: 'drops/b/', byteSize: 1, fileCount: 1 }))
      .rejects.toBeInstanceOf(DropConflictError);
  });

  it('replaces version atomically and returns previous version id', async () => {
    const first = await createDropAndVersion(ownerA, 'site', { r2Prefix: 'drops/v1/', byteSize: 1, fileCount: 1 });
    const { oldVersionId, newVersionId } = await replaceVersion(first.dropId, ownerA, {
      r2Prefix: 'drops/v2/', byteSize: 2, fileCount: 2,
    });
    expect(oldVersionId).toBe(first.versionId);
    const row = await findByOwnerAndName(ownerA, 'site');
    expect(row?.currentVersion).toBe(newVersionId);
    expect(row?.version?.byteSize).toBe(2);
  });

  it('replaceVersion with wrong owner throws', async () => {
    const first = await createDropAndVersion(ownerA, 'site', { r2Prefix: 'drops/x/', byteSize: 1, fileCount: 1 });
    await expect(replaceVersion(first.dropId, ownerB, {
      r2Prefix: 'drops/y/', byteSize: 1, fileCount: 1,
    })).rejects.toThrow(/not found/);
  });

  it('listByOwner includes version info', async () => {
    await createDropAndVersion(ownerA, 'one', { r2Prefix: 'drops/o/', byteSize: 10, fileCount: 1 });
    await createDropAndVersion(ownerA, 'two', { r2Prefix: 'drops/t/', byteSize: 20, fileCount: 2 });
    const list = await listByOwner(ownerA);
    expect(list.map((d) => d.name).sort()).toEqual(['one', 'two']);
    expect(list.every((d) => d.version !== null)).toBe(true);
  });

  it('listAllVisible joins owner username', async () => {
    await createDropAndVersion(ownerA, 'a-site', { r2Prefix: 'drops/a/', byteSize: 1, fileCount: 1 });
    await createDropAndVersion(ownerB, 'b-site', { r2Prefix: 'drops/b/', byteSize: 1, fileCount: 1 });
    const list = await listAllVisible({ id: ownerA, email: 'a@x.com' }, 25, 0);
    const usernames = new Set(list.map((d) => d.ownerUsername));
    expect(usernames.has('alice')).toBe(true);
    expect(usernames.has('bob')).toBe(true);
  });

  it('deleteDrop removes the drop and cascades versions; rejects wrong owner', async () => {
    const { dropId } = await createDropAndVersion(ownerA, 'site', {
      r2Prefix: 'drops/v1/', byteSize: 1, fileCount: 1,
    });
    expect(await deleteDrop(dropId, ownerB)).toBe(false);
    expect(await deleteDrop(dropId, ownerA)).toBe(true);
    expect(await findByOwnerAndName(ownerA, 'site')).toBeNull();
    const versions = await db.select().from(dropVersions);
    expect(versions.length).toBe(0);
  });

  it('summary includes viewMode (default authed)', async () => {
    await createDropAndVersion(ownerA, 'vm', { r2Prefix: 'drops/vm/', byteSize: 1, fileCount: 1 });
    const s = await findByOwnerAndName(ownerA, 'vm');
    expect(s!.viewMode).toBe('authed');
  });
});

describe('listAllVisibleUnpaged', () => {
  beforeEach(async () => {
    await db.delete(dropViewers);
    await db.delete(drops);
    await db.delete(users);
    const [a] = await db.insert(users).values({ email: 'a@x.com', username: 'alice' }).returning();
    const [b] = await db.insert(users).values({ email: 'b@x.com', username: 'bob' }).returning();
    ownerA = a!.id;
    ownerB = b!.id;
  });

  it('returns every visible drop (own + public + authed + listed emails) and excludes unlisted emails drops', async () => {
    // Seed > 25 to prove the helper is not secretly paged.
    for (let i = 0; i < 30; i++) {
      await db.insert(drops).values({
        ownerId: ownerA,
        name: `alice-own-${String(i).padStart(2, '0')}`,
        viewMode: 'authed',
      });
    }
    const [publicDrop] = await db.insert(drops).values({
      ownerId: ownerB, name: 'bobs-public', viewMode: 'public',
    }).returning();
    const [authedDrop] = await db.insert(drops).values({
      ownerId: ownerB, name: 'bobs-authed', viewMode: 'authed',
    }).returning();
    const [visibleEmail] = await db.insert(drops).values({
      ownerId: ownerB, name: 'bobs-visible-email', viewMode: 'emails',
    }).returning();
    const [hiddenEmail] = await db.insert(drops).values({
      ownerId: ownerB, name: 'bobs-hidden-email', viewMode: 'emails',
    }).returning();
    await db.insert(dropViewers).values({ dropId: visibleEmail!.id, email: 'a@x.com' });

    const list = await listAllVisibleUnpaged({ id: ownerA, email: 'a@x.com' });
    const ids = new Set(list.map((d) => d.id));
    expect(list.length).toBe(30 + 3); // 30 alice-own + public + authed + visible email
    expect(ids.has(publicDrop!.id)).toBe(true);
    expect(ids.has(authedDrop!.id)).toBe(true);
    expect(ids.has(visibleEmail!.id)).toBe(true);
    expect(ids.has(hiddenEmail!.id)).toBe(false);

    // Ordered alphabetically by name.
    const names = list.map((d) => d.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
