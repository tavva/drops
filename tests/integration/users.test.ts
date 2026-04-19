import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { users } from '@/db/schema';
import { createUser, findByEmail, findByUsername, isUsernameTaken, UserConflictError } from '@/services/users';

beforeEach(async () => { await db.delete(users); });

describe('users service', () => {
  it('creates and looks up a user', async () => {
    const u = await createUser({ email: 'a@b.com', username: 'alpha', name: 'Alpha', avatarUrl: null });
    expect(u.username).toBe('alpha');
    expect((await findByEmail('a@b.com'))?.id).toBe(u.id);
    expect((await findByUsername('alpha'))?.id).toBe(u.id);
  });
  it('is case-insensitive on email lookup', async () => {
    await createUser({ email: 'a@b.com', username: 'alpha', name: null, avatarUrl: null });
    expect(await findByEmail('A@B.com')).not.toBeNull();
  });
  it('isUsernameTaken returns true/false', async () => {
    await createUser({ email: 'a@b.com', username: 'alpha', name: null, avatarUrl: null });
    expect(await isUsernameTaken('alpha')).toBe(true);
    expect(await isUsernameTaken('beta')).toBe(false);
  });
  it('throws UserConflictError on duplicate username', async () => {
    await createUser({ email: 'a@b.com', username: 'alpha', name: null, avatarUrl: null });
    await expect(createUser({ email: 'c@d.com', username: 'alpha', name: null, avatarUrl: null }))
      .rejects.toBeInstanceOf(UserConflictError);
  });
  it('throws UserConflictError on duplicate email', async () => {
    await createUser({ email: 'a@b.com', username: 'alpha', name: null, avatarUrl: null });
    await expect(createUser({ email: 'a@b.com', username: 'beta', name: null, avatarUrl: null }))
      .rejects.toBeInstanceOf(UserConflictError);
  });

  it('createUser defaults kind to member', async () => {
    const { createUser } = await import('@/services/users');
    const u = await createUser({ email: 'm@x.com', username: 'm', name: null, avatarUrl: null });
    expect(u.kind).toBe('member');
  });

  it('createViewerUser creates a user with kind=viewer and null username', async () => {
    const { createViewerUser } = await import('@/services/users');
    const u = await createViewerUser({ email: 'v@x.com', name: null, avatarUrl: null });
    expect(u.kind).toBe('viewer');
    expect(u.username).toBeNull();
  });

  it('setUserKind flips kind and does not touch username', async () => {
    const { createUser, setUserKind, findByEmail } = await import('@/services/users');
    await createUser({ email: 'u@x.com', username: 'u', name: null, avatarUrl: null });
    const before = await findByEmail('u@x.com');
    await setUserKind(before!.id, 'viewer');
    const after = await findByEmail('u@x.com');
    expect(after!.kind).toBe('viewer');
    expect(after!.username).toBe('u');
  });

  it('setUsername updates null username in place', async () => {
    const { createViewerUser, setUsername, findByEmail } = await import('@/services/users');
    await createViewerUser({ email: 'p@x.com', name: null, avatarUrl: null });
    const u = await findByEmail('p@x.com');
    await setUsername(u!.id, 'picked');
    const after = await findByEmail('p@x.com');
    expect(after!.username).toBe('picked');
  });

  it('setUsername throws UserConflictError on duplicate', async () => {
    const { createUser, createViewerUser, setUsername, findByEmail, UserConflictError } =
      await import('@/services/users');
    await createUser({ email: 'taken@x.com', username: 'shared', name: null, avatarUrl: null });
    await createViewerUser({ email: 'other@x.com', name: null, avatarUrl: null });
    const v = await findByEmail('other@x.com');
    await expect(setUsername(v!.id, 'shared')).rejects.toBeInstanceOf(UserConflictError);
  });
});
