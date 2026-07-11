// ABOUTME: Integration coverage for issuing, exchanging, looking up, and revoking CLI credentials.
// ABOUTME: Verifies PKCE binding, hash-only storage, atomic replay protection, usage throttling, and cleanup.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { cliAuthorizationCodes, cliTokens, users } from '@/db/schema';
import {
  CliAuthError,
  deleteExpiredCliAuthorizationCodes,
  exchangeCliAuthorizationCode,
  issueCliAuthorizationCode,
  listCliTokens,
  lookupCliToken,
  revokeCliToken,
  revokeCliTokenByOwner,
} from '@/services/cliAuth';

const redirectUri = 'http://127.0.0.1:43123/callback';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

let memberId: string;

beforeEach(async () => {
  await db.delete(cliTokens);
  await db.delete(cliAuthorizationCodes);
  await db.delete(users);
  const [member] = await db.insert(users).values({
    email: 'member@example.com', username: 'member', kind: 'member', name: 'Member',
  }).returning();
  memberId = member!.id;
});

async function issueAndExchange(label = 'Ben’s Mac') {
  const issued = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
  return exchangeCliAuthorizationCode({
    code: issued.code, verifier, redirectUri, label,
  });
}

describe('CLI authorisation codes', () => {
  it('stores only a SHA-256 hash and expires the code after five minutes', async () => {
    const before = Date.now();
    const issued = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    const [row] = await db.select().from(cliAuthorizationCodes);

    expect(issued.code).not.toBe(row!.codeHash);
    expect(row!.codeHash).toBe(createHash('sha256').update(issued.code).digest('hex'));
    expect(row).toMatchObject({ userId: memberId, redirectUri, codeChallenge: challenge, consumedAt: null });
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000);
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(before + 5 * 60_000 + 1_000);
  });

  it('rejects issue for viewers and incomplete members', async () => {
    const [viewer, incomplete] = await db.insert(users).values([
      { email: 'viewer@example.com', kind: 'viewer' },
      { email: 'incomplete@example.com', kind: 'member' },
    ]).returning();

    await expect(issueCliAuthorizationCode({ userId: viewer!.id, redirectUri, codeChallenge: challenge }))
      .rejects.toMatchObject({ code: 'invalid_user' });
    await expect(issueCliAuthorizationCode({ userId: incomplete!.id, redirectUri, codeChallenge: challenge }))
      .rejects.toMatchObject({ code: 'invalid_user' });
  });

  it('requires the exact redirect URI and matching S256 verifier', async () => {
    const first = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    await expect(exchangeCliAuthorizationCode({
      code: first.code, verifier, redirectUri: `${redirectUri}/`, label: 'Mac',
    })).rejects.toMatchObject({ code: 'invalid_grant' });

    const second = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    await expect(exchangeCliAuthorizationCode({
      code: second.code, verifier: 'x'.repeat(64), redirectUri, label: 'Mac',
    })).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('rejects expired codes', async () => {
    const issued = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    await db.update(cliAuthorizationCodes).set({ expiresAt: new Date(Date.now() - 1) });
    await expect(exchangeCliAuthorizationCode({
      code: issued.code, verifier, redirectUri, label: 'Mac',
    })).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('allows exactly one concurrent exchange and consumes the code atomically', async () => {
    const issued = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => exchangeCliAuthorizationCode({
      code: issued.code, verifier, redirectUri, label: 'Mac',
    })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
    expect(await db.select().from(cliTokens)).toHaveLength(1);
    const [codeRow] = await db.select().from(cliAuthorizationCodes);
    expect(codeRow!.consumedAt).not.toBeNull();
  });

  it('deletes expired and consumed codes but keeps live unused codes', async () => {
    const expired = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    const consumed = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    const live = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
    await db.update(cliAuthorizationCodes).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(cliAuthorizationCodes.codeHash, createHash('sha256').update(expired.code).digest('hex')));
    await exchangeCliAuthorizationCode({ code: consumed.code, verifier, redirectUri, label: 'Mac' });

    expect(await deleteExpiredCliAuthorizationCodes()).toBe(2);
    const rows = await db.select().from(cliAuthorizationCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(createHash('sha256').update(live.code).digest('hex'));
  });
});

describe('CLI token lifecycle', () => {
  it('returns a random prefixed 256-bit token, stores only its hash, label, and owner', async () => {
    const first = await issueAndExchange('Work Mac');
    const second = await issueAndExchange('Work Mac');
    const rows = await db.select().from(cliTokens);

    expect(first.token).toMatch(/^drops_cli_[A-Za-z0-9_-]{43,}$/);
    expect(first.token).not.toBe(second.token);
    expect(rows.map((row) => row.tokenHash)).toContain(createHash('sha256').update(first.token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(first.token);
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ userId: memberId, label: 'Work Mac' });
    expect(first.user).toMatchObject({ id: memberId, username: 'member', kind: 'member' });
  });

  it.each(['', ' '.repeat(3), 'x'.repeat(101), 'bad\nlabel', 'bad\u0000label'])(
    'rejects invalid label %j without consuming the code',
    async (label) => {
      const issued = await issueCliAuthorizationCode({ userId: memberId, redirectUri, codeChallenge: challenge });
      await expect(exchangeCliAuthorizationCode({ code: issued.code, verifier, redirectUri, label }))
        .rejects.toBeInstanceOf(CliAuthError);
      const [row] = await db.select().from(cliAuthorizationCodes);
      expect(row!.consumedAt).toBeNull();
    },
  );

  it('looks up only active completed-member tokens and throttles last-used writes for one hour', async () => {
    const issued = await issueAndExchange();
    const found = await lookupCliToken(issued.token);
    expect(found).toMatchObject({ id: issued.id, user: { id: memberId, username: 'member' } });
    const [firstRow] = await db.select().from(cliTokens).where(eq(cliTokens.id, issued.id));
    expect(firstRow!.lastUsedAt).not.toBeNull();

    const preserved = new Date(Date.now() - 30 * 60_000);
    await db.update(cliTokens).set({ lastUsedAt: preserved }).where(eq(cliTokens.id, issued.id));
    await lookupCliToken(issued.token);
    const [throttled] = await db.select().from(cliTokens).where(eq(cliTokens.id, issued.id));
    expect(throttled!.lastUsedAt).toEqual(preserved);

    const stale = new Date(Date.now() - 61 * 60_000);
    await db.update(cliTokens).set({ lastUsedAt: stale }).where(eq(cliTokens.id, issued.id));
    await lookupCliToken(issued.token);
    const [refreshed] = await db.select().from(cliTokens).where(eq(cliTokens.id, issued.id));
    expect(refreshed!.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('rejects tokens whose owner becomes a viewer or loses their username', async () => {
    const viewerToken = await issueAndExchange();
    await db.update(users).set({ kind: 'viewer' }).where(eq(users.id, memberId));
    expect(await lookupCliToken(viewerToken.token)).toBeNull();

    await db.update(users).set({ kind: 'member', username: 'member' }).where(eq(users.id, memberId));
    const incompleteToken = await issueAndExchange();
    await db.update(users).set({ username: null }).where(eq(users.id, memberId));
    expect(await lookupCliToken(incompleteToken.token)).toBeNull();
  });

  it('supports self-revocation, owner-scoped dashboard revocation, and safe listing', async () => {
    const first = await issueAndExchange('First');
    const second = await issueAndExchange('Second');
    const [other] = await db.insert(users).values({
      email: 'other@example.com', username: 'other', kind: 'member',
    }).returning();

    expect(await revokeCliToken(first.id)).toBe(true);
    expect(await lookupCliToken(first.token)).toBeNull();
    expect(await revokeCliTokenByOwner(second.id, other!.id)).toBe(false);
    expect(await lookupCliToken(second.token)).not.toBeNull();
    expect(await revokeCliTokenByOwner(second.id, memberId)).toBe(true);
    expect(await lookupCliToken(second.token)).toBeNull();

    const listed = await listCliTokens(memberId);
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(listed)).not.toContain(first.token);
  });
});
