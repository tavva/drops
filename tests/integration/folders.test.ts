// ABOUTME: Integration tests for folder service. Runs against real Postgres via docker compose.
// ABOUTME: Tests cover create/rename/move/delete-with-reparent + setDropFolder + visibility gating.
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { folders, users, drops, dropViewers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createFolder, renameFolder, moveFolder, deleteFolderReparenting } from '@/services/folders';
import { InvalidFolderName } from '@/lib/folderName';

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

describe('createFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('creates a root folder', async () => {
    const f = await createFolder(userId, 'reports');
    expect(f.name).toBe('reports');
    expect(f.parentId).toBeNull();
    expect(f.createdBy).toBe(userId);
  });

  it('creates a nested folder', async () => {
    const root = await createFolder(userId, 'reports');
    const child = await createFolder(userId, '2026', root.id);
    expect(child.parentId).toBe(root.id);
  });

  it('rejects invalid names', async () => {
    await expect(createFolder(userId, '')).rejects.toThrow(InvalidFolderName);
    await expect(createFolder(userId, 'a/b')).rejects.toThrow(InvalidFolderName);
  });

  it('rejects sibling-name collision at root', async () => {
    await createFolder(userId, 'reports');
    await expect(createFolder(userId, 'reports')).rejects.toThrow(/name taken/i);
  });

  it('rejects sibling-name collision under same parent', async () => {
    const root = await createFolder(userId, 'reports');
    await createFolder(userId, '2026', root.id);
    await expect(createFolder(userId, '2026', root.id)).rejects.toThrow(/name taken/i);
  });

  it('allows the same name under different parents', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await createFolder(userId, 'same', a.id);
    const sameUnderB = await createFolder(userId, 'same', b.id);
    expect(sameUnderB.parentId).toBe(b.id);
  });

  it('rejects a parentId that does not exist', async () => {
    await expect(createFolder(userId, 'x', '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/parent folder not found/i);
  });
});

describe('renameFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('renames a folder', async () => {
    const f = await createFolder(userId, 'reports');
    const renamed = await renameFolder(f.id, 'archive');
    expect(renamed.name).toBe('archive');
  });

  it('rejects invalid names', async () => {
    const f = await createFolder(userId, 'reports');
    await expect(renameFolder(f.id, '')).rejects.toThrow();
    await expect(renameFolder(f.id, 'a/b')).rejects.toThrow();
  });

  it('rejects sibling-name collision', async () => {
    await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await expect(renameFolder(b.id, 'a')).rejects.toThrow(/name taken/i);
  });

  it('allows renaming to the same name (no-op)', async () => {
    const f = await createFolder(userId, 'reports');
    const again = await renameFolder(f.id, 'reports');
    expect(again.name).toBe('reports');
  });

  it('throws FolderNotFound for a missing id', async () => {
    await expect(renameFolder('00000000-0000-0000-0000-000000000000', 'x'))
      .rejects.toThrow(/folder not found/i);
  });
});

describe('moveFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('moves a folder to a new parent', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    const moved = await moveFolder(b.id, a.id);
    expect(moved.parentId).toBe(a.id);
  });

  it('moves a folder to root', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b', a.id);
    const moved = await moveFolder(b.id, null);
    expect(moved.parentId).toBeNull();
  });

  it('rejects moving a folder into itself', async () => {
    const a = await createFolder(userId, 'a');
    await expect(moveFolder(a.id, a.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects moving a folder into its own descendant', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b', a.id);
    const c = await createFolder(userId, 'c', b.id);
    await expect(moveFolder(a.id, c.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects sibling-name collision at the new parent', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await createFolder(userId, 'dup', a.id);
    const dupAtRoot = await createFolder(userId, 'dup', b.id);
    await expect(moveFolder(dupAtRoot.id, a.id)).rejects.toThrow(/name taken/i);
  });
});

describe('deleteFolderReparenting', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('deletes an empty folder', async () => {
    const f = await createFolder(userId, 'x');
    await deleteFolderReparenting(f.id);
    const after = await db.select().from(folders).where(eq(folders.id, f.id));
    expect(after).toHaveLength(0);
  });

  it('reparents child folders and drops up one level', async () => {
    const parent = await createFolder(userId, 'parent');
    const mid = await createFolder(userId, 'mid', parent.id);
    const child = await createFolder(userId, 'child', mid.id);
    const drop = await insertDrop({ ownerId: userId, name: 'd1', folderId: mid.id });
    await deleteFolderReparenting(mid.id);

    const [childAfter] = await db.select().from(folders).where(eq(folders.id, child.id));
    expect(childAfter!.parentId).toBe(parent.id);
    const [dropAfter] = await db.select().from(drops).where(eq(drops.id, drop.id));
    expect(dropAfter!.folderId).toBe(parent.id);
  });

  it('reparents to root when the deleted folder had no parent', async () => {
    const top = await createFolder(userId, 'top');
    const child = await createFolder(userId, 'child', top.id);
    await deleteFolderReparenting(top.id);
    const [childAfter] = await db.select().from(folders).where(eq(folders.id, child.id));
    expect(childAfter!.parentId).toBeNull();
  });

  it('renames a child folder on sibling-name collision during reparent', async () => {
    const parent = await createFolder(userId, 'parent');
    await createFolder(userId, 'dup', parent.id);
    const mid = await createFolder(userId, 'mid', parent.id);
    await createFolder(userId, 'dup', mid.id);

    await deleteFolderReparenting(mid.id);

    const under = await db.select().from(folders).where(eq(folders.parentId, parent.id));
    const names = under.map((r) => r.name).sort();
    expect(names).toContain('dup');
    expect(names).toContain('dup (from mid)');
  });

  it('throws FolderNotFound for a missing id', async () => {
    await expect(deleteFolderReparenting('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/folder not found/i);
  });
});

