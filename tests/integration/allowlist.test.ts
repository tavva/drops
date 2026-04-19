import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { isEmailAllowed } from '@/services/allowlist';

beforeAll(async () => {
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'friend@outside.com' });
});

describe('isEmailAllowed', () => {
  it('allows an email in the table', async () => {
    expect(await isEmailAllowed('friend@outside.com')).toBe(true);
  });
  it('allows an email in the domain', async () => {
    expect(await isEmailAllowed('anyone@example.com')).toBe(true);
  });
  it('rejects neither', async () => {
    expect(await isEmailAllowed('nope@some-other-domain.test')).toBe(false);
  });
  it('is case-insensitive on email', async () => {
    expect(await isEmailAllowed('FRIEND@outside.com')).toBe(true);
  });
});

describe('isMemberEmail', () => {
  it('accepts domain match and allowed_emails rows; normalises input', async () => {
    const { db } = await import('@/db');
    const { allowedEmails } = await import('@/db/schema');
    await db.delete(allowedEmails);
    await db.insert(allowedEmails).values({ email: 'explicit@x.com' });
    const { isMemberEmail } = await import('@/services/allowlist');
    expect(await isMemberEmail('ANYONE@example.com')).toBe(true);
    expect(await isMemberEmail(' Explicit@X.com ')).toBe(true);
    expect(await isMemberEmail('stranger@other.com')).toBe(false);
  });
});

describe('canSignInAsViewer', () => {
  it('true when the email owns at least one drop (demoted owner)', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers, allowedEmails } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users);
    await db.delete(dropViewers); await db.delete(allowedEmails);
    const [u] = await db.insert(users).values({
      email: 'exmember@other.test', username: 'ex', kind: 'viewer',
    }).returning();
    await db.insert(drops).values({ ownerId: u!.id, name: 's', viewMode: 'authed' });
    const { canSignInAsViewer } = await import('@/services/allowlist');
    expect(await canSignInAsViewer('exmember@other.test')).toBe(true);
  });

  it('true when a public drop exists', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers, allowedEmails } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users);
    await db.delete(dropViewers); await db.delete(allowedEmails);
    const [u] = await db.insert(users).values({
      email: 'owner@example.com', username: 'o', kind: 'member',
    }).returning();
    await db.insert(drops).values({ ownerId: u!.id, name: 's', viewMode: 'public' });
    const { canSignInAsViewer } = await import('@/services/allowlist');
    expect(await canSignInAsViewer('random@somewhere.org')).toBe(true);
  });

  it('true when email is listed on any drop', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users); await db.delete(dropViewers);
    const [u] = await db.insert(users).values({
      email: 'owner@example.com', username: 'o', kind: 'member',
    }).returning();
    const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 's', viewMode: 'emails' }).returning();
    await db.insert(dropViewers).values({ dropId: d!.id, email: 'listed@elsewhere.io' });
    const { canSignInAsViewer } = await import('@/services/allowlist');
    expect(await canSignInAsViewer('Listed@Elsewhere.IO')).toBe(true);
    expect(await canSignInAsViewer('not-listed@elsewhere.io')).toBe(false);
  });

  it('false when no public drops and no list entries', async () => {
    const { db } = await import('@/db');
    const { drops, dropViewers } = await import('@/db/schema');
    await db.delete(drops); await db.delete(dropViewers);
    const { canSignInAsViewer } = await import('@/services/allowlist');
    expect(await canSignInAsViewer('x@y.z')).toBe(false);
  });
});
