// ABOUTME: Validates and handles browser approval or denial for CLI PKCE authorisation.
// ABOUTME: Loopback callbacks are restricted to 127.0.0.1 ephemeral ports and an exact path.
import type { FastifyPluginAsync } from 'fastify';
import { config } from '@/config';
import { requireCompletedMember } from '@/middleware/auth';
import { issueCliAuthorizationCode } from '@/services/cliAuth';

export class CliAuthorizationRequestError extends Error {
  readonly code = 'invalid_request';

  constructor() {
    super('Invalid CLI authorisation request');
    this.name = 'CliAuthorizationRequestError';
  }
}

type UntrustedAuthorizationRequest = Record<string, unknown>;

export type CliAuthorizationRequest = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

function oneString(value: unknown): string {
  if (typeof value !== 'string') throw new CliAuthorizationRequestError();
  return value;
}

export function validateCliRedirectUri(value: unknown): string {
  const redirectUri = oneString(value);
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{4})\/callback$/u.exec(redirectUri);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 49_152 || port > 65_535) {
    throw new CliAuthorizationRequestError();
  }
  return redirectUri;
}

export function validateCliAuthorizationRequest(input: UntrustedAuthorizationRequest): CliAuthorizationRequest {
  const redirectUri = validateCliRedirectUri(input.redirect_uri);
  const state = oneString(input.state);
  const codeChallenge = oneString(input.code_challenge);
  const method = oneString(input.code_challenge_method);

  if (!/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) || method !== 'S256') {
    throw new CliAuthorizationRequestError();
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(state)) throw new CliAuthorizationRequestError();

  return { redirectUri, state, codeChallenge };
}

export function approvalCallback(redirectUri: string, code: string, state: string): URL {
  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);
  return callback;
}

export function denialCallback(redirectUri: string, state: string): URL {
  const callback = new URL(redirectUri);
  callback.searchParams.set('error', 'access_denied');
  callback.searchParams.set('state', state);
  return callback;
}

function invalidRequest(reply: import('fastify').FastifyReply) {
  return reply.code(400).send('invalid_request');
}

export const cliAuthorizeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/app/cli/authorize', { preHandler: requireCompletedMember }, async (req, reply) => {
    let authorization: CliAuthorizationRequest;
    try {
      authorization = validateCliAuthorizationRequest(req.query as UntrustedAuthorizationRequest);
    } catch (error) {
      if (error instanceof CliAuthorizationRequestError) return invalidRequest(reply);
      throw error;
    }
    return reply.view('cliAuthorize.ejs', {
      ...authorization,
      codeChallengeMethod: 'S256',
      csrfToken: req.csrfToken ?? '',
      instance: new URL(config.APP_ORIGIN).host,
    });
  });

  app.post('/app/cli/authorize/approve', { preHandler: requireCompletedMember }, async (req, reply) => {
    let authorization: CliAuthorizationRequest;
    try {
      authorization = validateCliAuthorizationRequest(req.body as UntrustedAuthorizationRequest);
    } catch (error) {
      if (error instanceof CliAuthorizationRequestError) return invalidRequest(reply);
      throw error;
    }
    const issued = await issueCliAuthorizationCode({
      userId: req.user!.id,
      redirectUri: authorization.redirectUri,
      codeChallenge: authorization.codeChallenge,
    });
    return reply.redirect(approvalCallback(
      authorization.redirectUri,
      issued.code,
      authorization.state,
    ).toString(), 302);
  });

  app.post('/app/cli/authorize/deny', { preHandler: requireCompletedMember }, async (req, reply) => {
    let authorization: CliAuthorizationRequest;
    try {
      authorization = validateCliAuthorizationRequest(req.body as UntrustedAuthorizationRequest);
    } catch (error) {
      if (error instanceof CliAuthorizationRequestError) return invalidRequest(reply);
      throw error;
    }
    return reply.redirect(denialCallback(authorization.redirectUri, authorization.state).toString(), 302);
  });
};
