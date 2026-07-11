// ABOUTME: Strict bearer-token middleware for CLI API routes.
// ABOUTME: Returns JSON 401 responses and attaches only completed-member identity plus the token id.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { lookupCliToken } from '@/services/cliAuth';

declare module 'fastify' {
  interface FastifyRequest {
    cliToken?: { id: string };
  }
}

function authorizationHeaderCount(request: FastifyRequest): number {
  let count = 0;
  const headers = request.raw.rawHeaders;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === 'authorization') count += 1;
  }
  return count;
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: {
      code: 'not_authenticated',
      message: 'A valid CLI bearer token is required',
      details: null,
    },
  });
}

export async function requireCliToken(request: FastifyRequest, reply: FastifyReply) {
  const authorization = request.headers.authorization;
  if (authorizationHeaderCount(request) !== 1 || typeof authorization !== 'string') {
    return unauthorized(reply);
  }
  const match = /^Bearer ([^\s,]+)$/iu.exec(authorization);
  if (!match) return unauthorized(reply);

  const found = await lookupCliToken(match[1]!);
  if (!found) return unauthorized(reply);

  request.cliToken = { id: found.id };
  request.user = found.user;
  request.log = request.log.child({ user_id: found.user.id, token_id: found.id });
}
