import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Writable } from 'node:stream';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;
let logLines: unknown[] = [];

const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      try { logLines.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
    cb();
  },
});

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { requireAppSession } = await import('@/middleware/auth');
  appInstance = await buildServer({ loggerStream: sink });
  await appInstance.register(onAppHost(async (s) => {
    s.get('/app/secure', { preHandler: requireAppSession }, async (req) => {
      req.log.info({ test: 'entry' }, 'hit secure');
      return { id: req.user!.id };
    });
  }));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(() => { logLines = []; });

describe('request logging', () => {
  it('emits request_id on every request', async () => {
    await appInstance.inject({ method: 'GET', url: '/health', headers: { host: 'drops.localtest.me' } });
    const sawRequestId = logLines.some((l) => (l as Record<string, unknown>).request_id);
    expect(sawRequestId).toBe(true);
  });

  it('attaches user_id after auth', async () => {
    const { db } = await import('@/db');
    const { users, sessions } = await import('@/db/schema');
    await db.delete(sessions);
    await db.delete(users);
    const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const sid = await createSession(u!.id);
    await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: {
        host: 'drops.localtest.me',
        cookie: `drops_session=${signCookie(sid, config.SESSION_SECRET)}`,
      },
    });
    const sawUserId = logLines.some((l) => (l as Record<string, unknown>).user_id === u!.id);
    expect(sawUserId).toBe(true);
  });
});
