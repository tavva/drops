// ABOUTME: Drop/version CRUD plus the atomic create-or-update and version-swap transactions.
// ABOUTME: The composite FK drops.current_version -> drop_versions(id, drop_id) is DEFERRABLE so both
// ABOUTME: the drop row and its first version can be inserted inside a single transaction.
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '@/db';
import { drops, dropVersions, users } from '@/db/schema';

export class DropConflictError extends Error {
  constructor() {
    super('drop with that name already exists');
    this.name = 'DropConflictError';
  }
}

export interface VersionInput {
  r2Prefix: string;
  byteSize: number;
  fileCount: number;
}

export interface DropSummary {
  id: string;
  name: string;
  ownerId: string;
  currentVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: {
    id: string;
    r2Prefix: string;
    byteSize: number;
    fileCount: number;
    createdAt: Date;
  } | null;
}

function pgErrorFrom(e: unknown): { code?: string; constraint_name?: string; constraint?: string } | null {
  const visited = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur);
    const obj = cur as { code?: string; cause?: unknown };
    if (obj.code) return obj as never;
    cur = obj.cause;
  }
  return null;
}

export async function createDropAndVersion(
  ownerId: string,
  name: string,
  version: VersionInput,
): Promise<{ dropId: string; versionId: string }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const [drop] = await tx.insert(drops).values({ ownerId, name }).returning();
      const [ver] = await tx.insert(dropVersions).values({
        dropId: drop!.id,
        r2Prefix: version.r2Prefix,
        byteSize: version.byteSize,
        fileCount: version.fileCount,
      }).returning();
      await tx.update(drops).set({ currentVersion: ver!.id, updatedAt: new Date() }).where(eq(drops.id, drop!.id));
      return { dropId: drop!.id, versionId: ver!.id };
    });
  } catch (e: unknown) {
    const pg = pgErrorFrom(e);
    if (pg?.code === '23505') throw new DropConflictError();
    throw e;
  }
}

export async function replaceVersion(
  dropId: string,
  ownerId: string,
  version: VersionInput,
): Promise<{ oldVersionId: string | null; newVersionId: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string; current_version: string | null }>(sql`
      SELECT id, current_version FROM drops
      WHERE id = ${dropId} AND owner_id = ${ownerId}
      FOR UPDATE
    `);
    if (!row) throw new Error('drop not found');
    const oldVersionId = row.current_version ?? null;
    const [ver] = await tx.insert(dropVersions).values({
      dropId,
      r2Prefix: version.r2Prefix,
      byteSize: version.byteSize,
      fileCount: version.fileCount,
    }).returning();
    await tx.update(drops).set({ currentVersion: ver!.id, updatedAt: new Date() }).where(eq(drops.id, dropId));
    return { oldVersionId, newVersionId: ver!.id };
  });
}

export async function findByOwnerAndName(ownerId: string, name: string): Promise<DropSummary | null> {
  const rows = await db.select({
    d: drops,
    v: dropVersions,
  }).from(drops)
    .leftJoin(dropVersions, eq(dropVersions.id, drops.currentVersion))
    .where(and(eq(drops.ownerId, ownerId), eq(drops.name, name)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return toSummary(r.d, r.v);
}

export async function listByOwner(ownerId: string): Promise<DropSummary[]> {
  const rows = await db.select({ d: drops, v: dropVersions }).from(drops)
    .leftJoin(dropVersions, eq(dropVersions.id, drops.currentVersion))
    .where(eq(drops.ownerId, ownerId))
    .orderBy(desc(drops.updatedAt));
  return rows.map((r) => toSummary(r.d, r.v));
}

export interface DropListItem extends DropSummary {
  ownerUsername: string;
}

export async function listAll(limit: number, offset: number): Promise<DropListItem[]> {
  const rows = await db.select({
    d: drops,
    v: dropVersions,
    username: users.username,
  }).from(drops)
    .innerJoin(users, eq(users.id, drops.ownerId))
    .leftJoin(dropVersions, eq(dropVersions.id, drops.currentVersion))
    .orderBy(desc(drops.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...toSummary(r.d, r.v), ownerUsername: r.username }));
}

export async function deleteDrop(dropId: string, ownerId: string): Promise<boolean> {
  const rows = await db.delete(drops)
    .where(and(eq(drops.id, dropId), eq(drops.ownerId, ownerId)))
    .returning({ id: drops.id });
  return rows.length > 0;
}

export async function listVersionsForDrop(dropId: string) {
  return db.select().from(dropVersions).where(eq(dropVersions.dropId, dropId));
}

function toSummary(
  d: typeof drops.$inferSelect,
  v: typeof dropVersions.$inferSelect | null,
): DropSummary {
  return {
    id: d.id,
    name: d.name,
    ownerId: d.ownerId,
    currentVersion: d.currentVersion,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    version: v
      ? {
          id: v.id,
          r2Prefix: v.r2Prefix,
          byteSize: v.byteSize,
          fileCount: v.fileCount,
          createdAt: v.createdAt,
        }
      : null,
  };
}
