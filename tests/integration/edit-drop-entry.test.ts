// ABOUTME: Integration tests for the entry-page picker on GET /app/drops/:name (the edit page).
// ABOUTME: Ambiguous drops render a <select> picker; no-HTML drops show the neutral note; a set entry_path renders selected.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { editDropRoute } = await import('@/routes/app/editDrop');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(editDropRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

let aliceId: string;
let aliceCookie: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers, sessions, allowedEmails } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops);
  await db.delete(sessions); await db.delete(users); await db.delete(allowedEmails);
  const [a] = await db.insert(users).values({
    email: 'alice@example.com', username: 'alice', kind: 'member',
  }).returning();
  aliceId = a!.id;

  const { createSession } = await import('@/services/sessions');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const aSid = await createSession(aliceId);
  aliceCookie = `drops_session=${signCookie(aSid, config.SESSION_SECRET)}`;
});

async function makeDrop(
  name: string,
  files: Array<{ path: string; body: Buffer; contentType?: string }>,
  entryPath: string | null = null,
): Promise<void> {
  const { db } = await import('@/db');
  const { drops, dropVersions } = await import('@/db/schema');
  const { putObject } = await import('@/lib/r2');
  const prefix = `drops/${name}-${Math.random().toString(36).slice(2)}/`;
  for (const f of files) await putObject(prefix + f.path, f.body, f.contentType);
  const [drop] = await db.insert(drops).values({ ownerId: aliceId, name, viewMode: 'authed' }).returning();
  const [ver] = await db.insert(dropVersions).values({
    dropId: drop!.id,
    r2Prefix: prefix,
    byteSize: files.reduce((s, f) => s + f.body.length, 0),
    fileCount: files.length,
    entryPath,
  }).returning();
  const { eq } = await import('drizzle-orm');
  await db.update(drops).set({ currentVersion: ver!.id }).where(eq(drops.id, drop!.id));
}

async function getEdit(name: string) {
  return appInstance.inject({
    method: 'GET', url: `/app/drops/${name}`,
    headers: { host: 'drops.localtest.me', cookie: aliceCookie },
  });
}

describe('GET /app/drops/:name entry picker', () => {
  it('ambiguous drop (multiple htmls, no root index.html, entry NULL) → renders the picker', async () => {
    await makeDrop('ambig', [
      { path: 'home.html', body: Buffer.from('<html>home</html>'), contentType: 'text/html' },
      { path: 'about.html', body: Buffer.from('<html>about</html>'), contentType: 'text/html' },
    ], null);
    const res = await getEdit('ambig');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<select[^>]*id="entry-select"/);
    expect(res.body).toContain('home.html');
    expect(res.body).toContain('about.html');
    expect(res.body).toContain('No homepage found');
  });

  it('no-HTML drop (PDFs only, multiple files) → shows the neutral note and no picker', async () => {
    await makeDrop('docs', [
      { path: 'paper.pdf', body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' },
      { path: 'slides.pdf', body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' },
    ], null);
    const res = await getEdit('docs');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/<select[^>]*id="entry-select"/);
    expect(res.body).toContain('no HTML page');
  });

  it('drop with entry_path set → that option is rendered selected', async () => {
    await makeDrop('chosen', [
      { path: 'home.html', body: Buffer.from('<html>home</html>'), contentType: 'text/html' },
      { path: 'about.html', body: Buffer.from('<html>about</html>'), contentType: 'text/html' },
    ], 'about.html');
    const res = await getEdit('chosen');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<select[^>]*id="entry-select"/);
    expect(res.body).toMatch(/<option value="about\.html"[^>]*selected[^>]*>about\.html<\/option>/);
  });
});
