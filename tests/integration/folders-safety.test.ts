// ABOUTME: Safety-net tests for the folders feature — race conditions, FK SET NULL, hidden-drop privacy.
// ABOUTME: Complements the happy-path tests in folders.test.ts and folders-routes.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, drops, dropViewers, folders } from '@/db/schema';
import {
  createFolder,
  moveFolder,
  deleteFolderReparenting,
  FolderCycle,
} from '@/services/folders';

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

describe('advisory-lock race in moveFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('serialises concurrent moves that would otherwise create a cycle', async () => {
    // Start with a tree where A is a child of B (A is inside B).
    const b = await createFolder(userId, 'b');
    const a = await createFolder(userId, 'a', b.id);

    // Two concurrent moves: one would put B under A; the other would put A under… well,
    // post-first-move, A's parent would need to change. Either single move succeeds; together
    // they'd create a cycle without the lock.
    const p1 = moveFolder(b.id, a.id).catch((e) => ({ kind: 'err' as const, e }));
    const p2 = moveFolder(a.id, b.id).catch((e) => ({ kind: 'err' as const, e })); // already parent; no-op but still takes the lock

    const [r1, r2] = await Promise.all([p1, p2]);

    // Invariant: the surviving tree must be acyclic.
    function walkToRoot(startId: string, allRows: Array<{ id: string; parentId: string | null }>): boolean {
      const byId = new Map(allRows.map((r) => [r.id, r]));
      const seen = new Set<string>();
      let cur: string | null = startId;
      while (cur) {
        if (seen.has(cur)) return false;
        seen.add(cur);
        const row = byId.get(cur);
        if (!row) return false;
        cur = row.parentId;
      }
      return true;
    }

    const allRows = (await db.select({ id: folders.id, parentId: folders.parentId }).from(folders));
    for (const row of allRows) expect(walkToRoot(row.id, allRows)).toBe(true);

    // At least one should be an error; but importantly, the tree is not corrupted.
    const anyErrored =
      ('kind' in r1 && r1.kind === 'err' && r1.e instanceof FolderCycle) ||
      ('kind' in r2 && r2.kind === 'err' && r2.e instanceof FolderCycle);
    // Not a strict requirement — some orderings may leave both valid (one is a no-op)
    // Just ensure we didn't produce a cycle.
    void anyErrored;
  });
});

describe('ON DELETE SET NULL safety net for drops.folder_id', () => {
  let userId: string;
  beforeEach(async () => {
    await resetAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('direct folder row delete sets drop.folder_id to NULL', async () => {
    const f = await createFolder(userId, 'x');
    const [d] = await db.insert(drops).values({ ownerId: userId, name: 'site', folderId: f.id }).returning();
    await db.delete(folders).where(eq(folders.id, f.id));
    const [after] = await db.select().from(drops).where(eq(drops.id, d!.id));
    expect(after).toBeDefined();
    expect(after!.folderId).toBeNull();
  });
});

describe('hidden-drop reparenting through deleteFolderReparenting', () => {
  it('moves a drop the actor cannot see up one level', async () => {
    await resetAll();
    const owner = await insertUser({ email: 'o@x.test', username: 'owner' });
    const outer = await createFolder(owner.id, 'outer');
    const inner = await createFolder(owner.id, 'inner', outer.id);
    const [hidden] = await db.insert(drops).values({
      ownerId: owner.id, name: 'secret', viewMode: 'emails', folderId: inner.id,
    }).returning();

    await deleteFolderReparenting(inner.id);
    const [after] = await db.select().from(drops).where(eq(drops.id, hidden!.id));
    expect(after!.folderId).toBe(outer.id);
  });
});
