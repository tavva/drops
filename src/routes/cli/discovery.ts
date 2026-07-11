// ABOUTME: Exposes unauthenticated CLI compatibility discovery on the app origin.
// ABOUTME: Reports the fixed service name, API version, and canonical configured app origin.
import type { FastifyPluginAsync } from 'fastify';
import { config } from '@/config';

export const cliDiscoveryRoute: FastifyPluginAsync = async (app) => {
  app.get('/.well-known/drops', async () => ({
    service: 'drops',
    apiVersion: 1,
    appOrigin: config.APP_ORIGIN,
  }));
};
