// ABOUTME: Single-use magic-link tokens for email-based viewer auth, with per-(email,drop) send dedupe.
// ABOUTME: issue is atomic under a per-key advisory lock; consume is an atomic claim of one row.
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { magicLinkTokens } from '@/db/schema';
import { normaliseEmail } from '@/lib/email';

export const MAGIC_TTL_SECONDS = 15 * 60;

export interface IssuedToken {
  token: string;
  created: boolean;
}

export interface ConsumedToken {
  email: string;
  dropId: string;
  next: string;
}

function lockKey(email: string, dropId: string): bigint {
  const h = createHash('sha256').update(`${email}:${dropId}`).digest();
  return h.readBigInt64BE(0);
}

export async function issueMagicToken(email: string, dropId: string, next: string): Promise<IssuedToken> {
  const normalised = normaliseEmail(email);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(normalised, dropId)})`);
    const [live] = await tx.select({ id: magicLinkTokens.id })
      .from(magicLinkTokens)
      .where(and(
        eq(magicLinkTokens.email, normalised),
        eq(magicLinkTokens.dropId, dropId),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ))
      .limit(1);
    if (live) return { token: live.id, created: false };

    const token = randomBytes(32).toString('base64url');
    await tx.insert(magicLinkTokens).values({
      id: token,
      email: normalised,
      dropId,
      next,
      expiresAt: new Date(Date.now() + MAGIC_TTL_SECONDS * 1000),
    });
    return { token, created: true };
  });
}

export async function consumeMagicToken(token: string): Promise<ConsumedToken | null> {
  const rows = await db.update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(magicLinkTokens.id, token),
      isNull(magicLinkTokens.consumedAt),
      gt(magicLinkTokens.expiresAt, new Date()),
    ))
    .returning({ email: magicLinkTokens.email, dropId: magicLinkTokens.dropId, next: magicLinkTokens.next });
  return rows[0] ?? null;
}

export async function deleteExpiredMagicTokens(): Promise<void> {
  await db.delete(magicLinkTokens)
    .where(sql`${magicLinkTokens.consumedAt} IS NOT NULL OR ${magicLinkTokens.expiresAt} <= now()`);
}
