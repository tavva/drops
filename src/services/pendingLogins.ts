// ABOUTME: Short-lived holder for OAuth-verified identities that haven't chosen a username yet.
// ABOUTME: Rows are consumed (deleted-and-returned) atomically when the user completes signup.
import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/db';
import { pendingLogins } from '@/db/schema';

export const PENDING_TTL_SECONDS = 600;

export interface PendingIdentity {
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export async function createPendingLogin(identity: PendingIdentity, ttlOverrideSeconds?: number): Promise<string> {
  const id = randomBytes(24).toString('base64url');
  const ttl = ttlOverrideSeconds ?? PENDING_TTL_SECONDS;
  await db.insert(pendingLogins).values({
    id,
    email: identity.email,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    expiresAt: new Date(Date.now() + ttl * 1000),
  });
  return id;
}

export async function consumePendingLogin(id: string): Promise<PendingIdentity | null> {
  const rows = await db.delete(pendingLogins)
    .where(and(eq(pendingLogins.id, id), gt(pendingLogins.expiresAt, new Date())))
    .returning();
  const r = rows[0];
  if (!r) return null;
  return { email: r.email, name: r.name, avatarUrl: r.avatarUrl };
}
