// ABOUTME: Garbage collection for orphaned drop_versions rows and their R2 prefixes.
// ABOUTME: gcVersion is idempotent; sweepOrphans runs gcVersion for every version not referenced as current_version.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dropVersions, drops } from '@/db/schema';
import { deletePrefix } from '@/lib/r2';

export async function gcVersion(versionId: string): Promise<void> {
  const rows = await db.select().from(dropVersions).where(eq(dropVersions.id, versionId));
  const row = rows[0];
  if (!row) return;
  await deletePrefix(row.r2Prefix);
  await db.delete(dropVersions).where(and(
    eq(dropVersions.id, versionId),
    sql`NOT EXISTS (SELECT 1 FROM drops WHERE current_version = ${versionId})`,
  ));
}

export async function findOrphans(): Promise<string[]> {
  const rows = await db.select({ id: dropVersions.id })
    .from(dropVersions)
    .leftJoin(drops, eq(drops.currentVersion, dropVersions.id))
    .where(isNull(drops.id));
  return rows.map((r) => r.id);
}

export async function sweepOrphans(): Promise<number> {
  const ids = await findOrphans();
  let count = 0;
  for (const id of ids) {
    try { await gcVersion(id); count++; }
    catch { /* retry on next sweep */ }
  }
  return count;
}
