// ABOUTME: Provides the bearer-only CLI token exchange, identity, and self-revocation API.
// ABOUTME: Token exchange and deletion skip browser CSRF because neither uses cookie authentication.
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireCliToken } from '@/middleware/cliAuth';
import { CliAuthorizationRequestError, validateCliRedirectUri } from '@/routes/cli/authorize';
import { tightAuthLimit } from '@/middleware/rateLimit';
import {
  CliAuthError,
  exchangeCliAuthorizationCode,
  revokeCliToken,
} from '@/services/cliAuth';

function apiError(reply: FastifyReply, code: 'invalid_request' | 'invalid_grant' | 'invalid_label') {
  const messages = {
    invalid_request: 'The token request is invalid',
    invalid_grant: 'The CLI authorisation is invalid or expired',
    invalid_label: 'The token label is invalid',
  };
  return reply.code(400).send({ error: { code, message: messages[code], details: null } });
}

type TokenRequest = {
  code: string;
  verifier: string;
  redirectUri: string;
  label: string;
};

function validateTokenRequest(body: unknown): TokenRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (
    typeof input.code !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.code)
    || typeof input.verifier !== 'string'
    || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.verifier)
    || typeof input.redirectUri !== 'string'
    || typeof input.label !== 'string'
  ) return null;

  try {
    validateCliRedirectUri(input.redirectUri);
  } catch (error) {
    if (!(error instanceof CliAuthorizationRequestError)) throw error;
    return null;
  }

  return {
    code: input.code,
    verifier: input.verifier,
    redirectUri: input.redirectUri,
    label: input.label,
  };
}

export const cliApiAuthErrorHandler: Parameters<FastifyInstance['setErrorHandler']>[0] = (error, req, reply) => {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error
    ? error.statusCode
    : undefined;
  if (statusCode === 413) {
    return reply.code(413).send({
      error: { code: 'payload_too_large', message: 'The token request is too large', details: null },
    });
  }
  if (statusCode === 400 || statusCode === 415) return apiError(reply, 'invalid_request');
  if (statusCode === 429) {
    return reply.code(429).send({
      error: { code: 'rate_limited', message: 'Too many token requests', details: null },
    });
  }
  const loggedError = error instanceof Error ? error : new Error('Unknown CLI auth API error');
  req.log.error({ err: loggedError, request_id: req.id }, 'CLI auth API request failed');
  return reply.code(500).send({
    error: { code: 'internal_error', message: 'An unexpected error occurred', details: null },
  });
};

export const cliApiAuthRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url === '/api/v1/auth/token') reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler(cliApiAuthErrorHandler);

  app.post('/api/v1/auth/token', {
    bodyLimit: 8 * 1024,
    config: { skipCsrf: true, ...tightAuthLimit },
  }, async (req, reply) => {
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return apiError(reply, 'invalid_request');
    }
    const input = validateTokenRequest(req.body);
    if (!input) return apiError(reply, 'invalid_request');
    try {
      const issued = await exchangeCliAuthorizationCode(input);
      return {
        token: issued.token,
        user: { id: issued.user.id, email: issued.user.email, username: issued.user.username },
      };
    } catch (error) {
      if (error instanceof CliAuthError) {
        return apiError(reply, error.code === 'invalid_label' ? 'invalid_label' : 'invalid_grant');
      }
      throw error;
    }
  });

  app.get('/api/v1/whoami', { preHandler: requireCliToken }, async (req) => ({
    id: req.user!.id,
    email: req.user!.email,
    username: req.user!.username,
  }));

  app.delete('/api/v1/auth/token', {
    config: { skipCsrf: true },
    preHandler: requireCliToken,
  }, async (req, reply) => {
    await revokeCliToken(req.cliToken!.id);
    return reply.code(204).send();
  });
};
