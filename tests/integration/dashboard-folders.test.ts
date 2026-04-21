// ABOUTME: Integration tests for GET /app with folders — renders tree, badges, mineOnly filter, hidden-drop safety.
// ABOUTME: Verifies that the view honours per-viewer visibility and the render-with-banner path.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { dashboardRoute } from '@/routes/app/dashboard';
import { db } from '@/db';
import { users, drops, dropViewers, folders, sessions } from '@/db/schema';
import { createSession } from '@/services/sessions';
import { signCookie } from '@/lib/cookies';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dashboardRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

let aliceId: string;
let bobId: string;
beforeEach(async () => {
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(folders);
  await db.delete(sessions);
  await db.delete(users);
  const [a] = await db.insert(users).values({ email: 'alice@x.test', username: 'alice' }).returning();
  const [b] = await db.insert(users).values({ email: 'bob@x.test', username: 'bob' }).returning();
  aliceId = a!.id;
  bobId = b!.id;
});

async function cookieFor(userId: string): Promise<string> {
  const sid = await createSession(userId);
  return `drops_session=${signCookie(sid, config.SESSION_SECRET)}`;
}

describe('GET /app with folders', () => {
  it('renders folder names seeded for the caller', async () => {
    await db.insert(folders).values({ name: 'reports', createdBy: aliceId });
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('>reports</span>');
  });

  it('renders a drop inside its folder', async () => {
    const [f] = await db.insert(folders).values({ name: 'work', createdBy: aliceId }).returning();
    await db.insert(drops).values({
      ownerId: aliceId, name: 'site', viewMode: 'public', folderId: f!.id,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    expect(res.statusCode).toBe(200);
    const folderMatch = res.body.indexOf(`data-folder-id="${f!.id}"`);
    expect(folderMatch).toBeGreaterThan(-1);
    const folderEnd = res.body.indexOf('</div>\n</div>', folderMatch);
    const inside = res.body.slice(folderMatch, folderEnd);
    expect(inside).toContain('site');
  });

  it('?mine=1 hides another owners visible drop but still shows their folder', async () => {
    const [f] = await db.insert(folders).values({ name: 'bobs-folder', createdBy: bobId }).returning();
    await db.insert(drops).values({
      ownerId: bobId, name: 'bob-drop', viewMode: 'public', folderId: f!.id,
    });
    await db.insert(drops).values({
      ownerId: aliceId, name: 'alice-drop', viewMode: 'public',
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/app?mine=1',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('>bobs-folder</span>');
    expect(res.body).not.toMatch(/>bob-drop</);
    expect(res.body).toMatch(/>alice-drop</);
  });

  it('badge on a folder reflects per-viewer visibility count', async () => {
    const [f] = await db.insert(folders).values({ name: 'stash', createdBy: aliceId }).returning();
    await db.insert(drops).values({
      ownerId: aliceId, name: 'only-mine', viewMode: 'emails', folderId: f!.id,
    });
    const asAlice = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    const asBob = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(bobId) },
    });
    expect(asAlice.body).toContain('>1</span>'); // count 1 for alice
    // Bob sees the folder but count is 0.
    expect(asBob.body).toContain('>stash</span>');
    expect(asBob.body).toContain('>0</span>');
    expect(asBob.body).not.toMatch(/>only-mine</);
  });

  it('renders (empty) placeholder for a folder with no visible content', async () => {
    await db.insert(folders).values({ name: 'nothing', createdBy: aliceId });
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    expect(res.body).toContain('(empty)');
  });

  it('delete confirm copy reflects visible count only (hides count of invisible drops)', async () => {
    const [f] = await db.insert(folders).values({ name: 'mixed', createdBy: aliceId }).returning();
    // visible to alice
    await db.insert(drops).values({
      ownerId: aliceId, name: 'visible-one', viewMode: 'public', folderId: f!.id,
    });
    // hidden from alice, but present in DB
    await db.insert(drops).values({
      ownerId: bobId, name: 'super-secret', viewMode: 'emails', folderId: f!.id,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await cookieFor(aliceId) },
    });
    // confirm copy mentions 1 drop (the visible one), not 2.
    expect(res.body).toMatch(/1 drop\(s\) and 0 subfolder\(s\)/);
    // hidden drop's name must not leak into the HTML anywhere (including the confirm dialog data attrs).
    expect(res.body).not.toContain('super-secret');
  });
});
