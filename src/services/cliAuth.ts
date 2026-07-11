// ABOUTME: Issues, exchanges, looks up, lists, and revokes hash-only CLI credentials.
// ABOUTME: Authorisation-code consumption and token creation happen atomically with PKCE S256 binding.
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { cliAuthorizationCodes, cliTokens, users } from '@/db/schema';

export const CLI_AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
export const CLI_TOKEN_USAGE_INTERVAL_MS = 60 * 60_000;

type CompletedMember = {
  id: string;
  email: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  kind: 'member';
};

export class CliAuthError extends Error {
  constructor(public readonly code: 'invalid_user' | 'invalid_grant' | 'invalid_label') {
    super(code === 'invalid_label' ? 'The token label is invalid' : 'The CLI authorisation is invalid');
    this.name = 'CliAuthError';
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asCompletedMember(row: typeof users.$inferSelect | undefined): CompletedMember | null {
  if (!row || row.kind !== 'member' || row.username === null) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    avatarUrl: row.avatarUrl,
    kind: 'member',
  };
}

function validateLabel(label: string): void {
  if (label.trim().length === 0 || label.length > 100 || /\p{Cc}/u.test(label)) {
    throw new CliAuthError('invalid_label');
  }
}

export async function issueCliAuthorizationCode(input: {
  userId: string;
  redirectUri: string;
  codeChallenge: string;
}): Promise<{ code: string; expiresAt: Date }> {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!asCompletedMember(user)) throw new CliAuthError('invalid_user');

  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CLI_AUTHORIZATION_CODE_TTL_MS);
  await db.insert(cliAuthorizationCodes).values({
    codeHash: hash(code),
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    expiresAt,
  });
  return { code, expiresAt };
}

export async function exchangeCliAuthorizationCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
  label: string;
}): Promise<{ id: string; token: string; user: CompletedMember }> {
  validateLabel(input.label);
  const codeHash = hash(input.code);
  const codeChallenge = createHash('sha256').update(input.verifier).digest('base64url');

  return db.transaction(async (tx) => {
    const [claimed] = await tx.update(cliAuthorizationCodes)
      .set({ consumedAt: new Date() })
      .where(and(
        eq(cliAuthorizationCodes.codeHash, codeHash),
        eq(cliAuthorizationCodes.redirectUri, input.redirectUri),
        eq(cliAuthorizationCodes.codeChallenge, codeChallenge),
        isNull(cliAuthorizationCodes.consumedAt),
        gt(cliAuthorizationCodes.expiresAt, new Date()),
      ))
      .returning({ userId: cliAuthorizationCodes.userId });
    if (!claimed) throw new CliAuthError('invalid_grant');

    const [userRow] = await tx.select().from(users).where(eq(users.id, claimed.userId)).limit(1);
    const user = asCompletedMember(userRow);
    if (!user) throw new CliAuthError('invalid_user');

    const token = `drops_cli_${randomBytes(32).toString('base64url')}`;
    const [created] = await tx.insert(cliTokens).values({
      userId: claimed.userId,
      tokenHash: hash(token),
      label: input.label,
    }).returning({ id: cliTokens.id });
    return { id: created!.id, token, user };
  });
}

export async function lookupCliToken(token: string): Promise<{
  id: string;
  user: CompletedMember;
} | null> {
  const [found] = await db.select({ token: cliTokens, user: users })
    .from(cliTokens)
    .innerJoin(users, eq(cliTokens.userId, users.id))
    .where(and(
      eq(cliTokens.tokenHash, hash(token)),
      isNull(cliTokens.revokedAt),
      eq(users.kind, 'member'),
      sql`${users.username} IS NOT NULL`,
    ))
    .limit(1);
  const user = asCompletedMember(found?.user);
  if (!found || !user) return null;

  const now = new Date();
  await db.update(cliTokens)
    .set({ lastUsedAt: now })
    .where(and(
      eq(cliTokens.id, found.token.id),
      isNull(cliTokens.revokedAt),
      or(
        isNull(cliTokens.lastUsedAt),
        lt(cliTokens.lastUsedAt, new Date(now.getTime() - CLI_TOKEN_USAGE_INTERVAL_MS)),
      ),
    ));
  return { id: found.token.id, user };
}

export async function revokeCliToken(tokenId: string): Promise<boolean> {
  const rows = await db.update(cliTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(cliTokens.id, tokenId), isNull(cliTokens.revokedAt)))
    .returning({ id: cliTokens.id });
  return rows.length === 1;
}

export async function revokeCliTokenByOwner(tokenId: string, ownerId: string): Promise<boolean> {
  const rows = await db.update(cliTokens)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(cliTokens.id, tokenId),
      eq(cliTokens.userId, ownerId),
      isNull(cliTokens.revokedAt),
    ))
    .returning({ id: cliTokens.id });
  return rows.length === 1;
}

export async function listCliTokens(ownerId: string) {
  return db.select({
    id: cliTokens.id,
    label: cliTokens.label,
    createdAt: cliTokens.createdAt,
    lastUsedAt: cliTokens.lastUsedAt,
    revokedAt: cliTokens.revokedAt,
  }).from(cliTokens)
    .where(eq(cliTokens.userId, ownerId))
    .orderBy(asc(cliTokens.createdAt));
}

export async function listActiveCliTokens(ownerId: string) {
  return db.select({
    id: cliTokens.id,
    label: cliTokens.label,
    createdAt: cliTokens.createdAt,
    lastUsedAt: cliTokens.lastUsedAt,
  }).from(cliTokens)
    .where(and(eq(cliTokens.userId, ownerId), isNull(cliTokens.revokedAt)))
    .orderBy(asc(cliTokens.createdAt));
}

export async function deleteExpiredCliAuthorizationCodes(): Promise<number> {
  const rows = await db.delete(cliAuthorizationCodes)
    .where(or(
      sql`${cliAuthorizationCodes.consumedAt} IS NOT NULL`,
      sql`${cliAuthorizationCodes.expiresAt} <= now()`,
    ))
    .returning({ codeHash: cliAuthorizationCodes.codeHash });
  return rows.length;
}
