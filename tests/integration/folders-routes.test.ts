// ABOUTME: Integration tests for folder HTTP routes on the app origin.
// ABOUTME: All mutations are POST + CSRF-protected; 303 on success, 400 on validation.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { dashboardRoute } from '@/routes/app/dashboard';
import { folderRoutes } from '@/routes/app/folders';
import { db } from '@/db';
import { users, drops, dropViewers, folders, sessions } from '@/db/schema';
import { createSession } from '@/services/sessions';
import { signCookie } from '@/lib/cookies';
import { issueCsrfToken, CSRF_COOKIE } from '@/lib/csrf';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dashboardRoute);
    await s.register(folderRoutes);
  }));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
let sid: string;
let signedSid: string;
let csrfToken: string;

async function cookieHeader() {
  return [
    `drops_session=${signedSid}`,
    `${CSRF_COOKIE}=${csrfToken}`,
  ].join('; ');
}

beforeEach(async () => {
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(folders);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@x.test', username: 'alice' }).returning();
  userId = u!.id;
  sid = await createSession(userId);
  signedSid = signCookie(sid, config.SESSION_SECRET);
  csrfToken = issueCsrfToken(sid);
});

describe('POST /app/folders', () => {
  it('creates a root folder and 303s to dashboard', async () => {
    const res = await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookieHeader(),
      },
      payload: `name=reports&_csrf=${csrfToken}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/app');
    const rows = await db.select().from(folders).where(eq(folders.name, 'reports'));
    expect(rows.length).toBe(1);
  });

  it('rejects requests without a CSRF token', async () => {
    const res = await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `drops_session=${signedSid}`,
      },
      payload: `name=reports`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('re-renders dashboard with 400 + inline banner on invalid name', async () => {
    const res = await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookieHeader(),
      },
      payload: `name=a%2Fb&_csrf=${csrfToken}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.body).toMatch(/Folder name is invalid/);
  });

  it('re-renders dashboard with 400 + inline banner on duplicate sibling name', async () => {
    await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookieHeader(),
      },
      payload: `name=reports&_csrf=${csrfToken}`,
    });
    const res = await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookieHeader(),
      },
      payload: `name=reports&_csrf=${csrfToken}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/already exists/);
  });

  it('re-renders dashboard with 400 + banner on malformed parentId (not a UUID)', async () => {
    const res = await appInstance.inject({
      method: 'POST', url: '/app/folders',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookieHeader(),
      },
      payload: `name=reports&parentId=not-a-uuid&_csrf=${csrfToken}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Invalid folder reference/);
  });
});
