// ABOUTME: CRUD for drop_viewers — the per-drop email allowlist used when view_mode = 'emails'.
// ABOUTME: Emails are stored lowercase+NFC via normaliseEmail; addViewer is idempotent.
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dropViewers } from '@/db/schema';
import { normaliseEmail } from '@/lib/email';

export async function addViewer(dropId: string, email: string): Promise<void> {
  await db.insert(dropViewers)
    .values({ dropId, email: normaliseEmail(email) })
    .onConflictDoNothing();
}

export async function removeViewer(dropId: string, email: string): Promise<boolean> {
  const rows = await db.delete(dropViewers)
    .where(and(eq(dropViewers.dropId, dropId), eq(dropViewers.email, normaliseEmail(email))))
    .returning({ email: dropViewers.email });
  return rows.length > 0;
}

export async function listViewers(dropId: string) {
  return db.select({ email: dropViewers.email, addedAt: dropViewers.addedAt })
    .from(dropViewers)
    .where(eq(dropViewers.dropId, dropId))
    .orderBy(dropViewers.addedAt);
}

export async function isViewerAllowed(dropId: string, email: string): Promise<boolean> {
  const [row] = await db.select({ one: sql<number>`1` })
    .from(dropViewers)
    .where(and(eq(dropViewers.dropId, dropId), eq(dropViewers.email, normaliseEmail(email))))
    .limit(1);
  return Boolean(row);
}
