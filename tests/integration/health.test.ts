import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  appInstance = await buildServer();
});

afterAll(async () => { await appInstance.close(); });

describe('GET /health', () => {
  it('returns 200 when DB and R2 both reachable', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/health',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: 'ok', r2: 'ok' });
  });
});
