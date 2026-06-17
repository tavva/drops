// ABOUTME: Serves /app/static/* from src/views/static on the app host.
import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';

export const STATIC_PREFIX = '/app/static/';

export const appStaticRoute: FastifyPluginAsync = async (app) => {
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), 'src/views/static'),
    prefix: STATIC_PREFIX,
    decorateReply: false,
  });
};
