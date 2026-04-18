// ABOUTME: Registers @fastify/helmet with host-appropriate CSP settings.
// ABOUTME: App host gets a strict same-origin CSP; content host disables CSP/frameguard (user-controlled HTML).
// ABOUTME: HSTS and upgrade-insecure-requests are only emitted when the origin is HTTPS so dev over HTTP works.
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { config } from '@/config';

function isHttps(origin: string): boolean {
  return new URL(origin).protocol === 'https:';
}

export async function registerAppSecurity(app: FastifyInstance) {
  const https = isHttps(config.APP_ORIGIN);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [`'self'`],
        styleSrc: [`'self'`],
        scriptSrc: [`'self'`],
        imgSrc: [`'self'`, 'data:'],
        connectSrc: [`'self'`],
        frameAncestors: [`'none'`],
        objectSrc: [`'none'`],
        baseUri: [`'self'`],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    hsts: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
}

export async function registerContentSecurity(app: FastifyInstance) {
  const https = isHttps(config.CONTENT_ORIGIN);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
}
