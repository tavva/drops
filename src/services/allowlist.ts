// ABOUTME: Decides how an email is admitted at sign-in time.
// ABOUTME: isMemberEmail gates the full-access app tier; canSignInAsViewer gates content-only access.
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { allowedEmails, drops, dropViewers } from '@/db/schema';
import { normaliseEmail } from '@/lib/email';
import { config } from '@/config';

export async function isMemberEmail(email: string): Promise<boolean> {
  const normalised = normaliseEmail(email);
  if (normalised.endsWith('@' + config.ALLOWED_DOMAIN.toLowerCase())) return true;
  const rows = await db.select().from(allowedEmails).where(eq(allowedEmails.email, normalised));
  return rows.length > 0;
}

export async function canSignInAsViewer(email: string): Promise<boolean> {
  const normalised = normaliseEmail(email);
  const ownedRows = await db.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM drops d
    INNER JOIN users u ON u.id = d.owner_id
    WHERE u.email = ${normalised}
    LIMIT 1
  `);
  if (ownedRows.length > 0) return true;
  const [publicRow] = await db.select({ one: sql<number>`1` })
    .from(drops).where(eq(drops.viewMode, 'public')).limit(1);
  if (publicRow) return true;
  const [listed] = await db.select({ one: sql<number>`1` })
    .from(dropViewers).where(eq(dropViewers.email, normalised)).limit(1);
  return Boolean(listed);
}

export const isEmailAllowed = isMemberEmail;
