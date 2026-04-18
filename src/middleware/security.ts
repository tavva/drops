// ABOUTME: Registers @fastify/helmet with host-appropriate CSP settings.
// ABOUTME: App host gets a strict same-origin CSP; content host disables CSP/frameguard (user-controlled HTML).
import helmet from '@fastify/helmet';
import { FastifyInstance } from 'fastify';

export async function registerAppSecurity(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        styleSrc: [`'self'`],
        scriptSrc: [`'self'`],
        imgSrc: [`'self'`, 'data:'],
        connectSrc: [`'self'`],
        frameAncestors: [`'none'`],
        objectSrc: [`'none'`],
        baseUri: [`'self'`],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
}

export async function registerContentSecurity(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
}
