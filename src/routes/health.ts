// ABOUTME: GET /health — deep probe of DB and R2 so Railway can detect degraded state.
import { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { db } from '@/db';
import { s3 } from '@/lib/r2';
import { config } from '@/config';

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    const status: { db: 'ok' | 'fail'; r2: 'ok' | 'fail' } = { db: 'ok', r2: 'ok' };
    try { await db.execute(sql`SELECT 1`); } catch { status.db = 'fail'; }
    try { await s3.send(new HeadBucketCommand({ Bucket: config.R2_BUCKET })); } catch { status.r2 = 'fail'; }
    const ok = status.db === 'ok' && status.r2 === 'ok';
    return reply.code(ok ? 200 : 503).send(status);
  });
};
