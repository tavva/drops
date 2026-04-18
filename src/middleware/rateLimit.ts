// ABOUTME: Registers @fastify/rate-limit at a baseline ceiling with tighter per-route overrides.
// ABOUTME: `rateLimit: false` on a route opts it out; auth and upload routes get their own keyed limits.
import rateLimit from '@fastify/rate-limit';
import { FastifyInstance } from 'fastify';

export async function registerRateLimit(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
  });
}

export const tightAuthLimit = {
  rateLimit: { max: 20, timeWindow: '1 minute' },
};

export const uploadLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (req: { cookies?: Record<string, string>; ip: string }) => req.cookies?.drops_session ?? req.ip,
  },
};
