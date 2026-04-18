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
});
