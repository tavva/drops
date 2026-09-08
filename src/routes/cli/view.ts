// ABOUTME: Bearer-authenticated content reads and host-bound browser handoffs for existing drops.
// ABOUTME: Enforces canView and serves downloads inertly on the app origin to preserve origin isolation.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { signHandoff } from '@/lib/handoff';
import { encodePath, sanitisePath } from '@/lib/path';
import { isValidSlug } from '@/lib/slug';
import { requireCliToken } from '@/middleware/cliAuth';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { getDropContent } from '@/services/dropContent';
import { findByOwnerAndName } from '@/services/drops';
import { canView } from '@/services/permissions';
import { findByUsername } from '@/services/users';

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, details: null } });
}

async function resolveDrop(request: FastifyRequest, reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
  const { name } = request.params as { name: string };
  const query = request.query as { owner?: string; path?: string };
  const username = query.owner ?? request.user!.username!;
  const path = query.path ?? '';
  if (!isValidSlug(name) || !isValidSlug(username)) {
    error(reply, 400, 'invalid_name', 'The owner and drop name must be valid slugs');
    return null;
  }
  // Directory requests are allowed, but every non-root segment must pass the normal path checks.
  if (path !== '' && !sanitisePath(path.endsWith('/') ? path.slice(0, -1) : path).ok) {
    error(reply, 400, 'invalid_path', 'Provide a relative drop file or directory path');
    return null;
  }
  const owner = await findByUsername(username);
  const drop = owner ? await findByOwnerAndName(owner.id, name) : null;
  if (!drop?.version || !await canView(request.user!, drop)) {
    error(reply, 404, 'drop_not_found', 'The drop does not exist or you do not have permission to view it');
    return null;
  }
  return { drop, version: drop.version, username, name, path };
}

export const cliViewRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((cause, request, reply) => {
    if ((cause as { validation?: unknown }).validation) {
      return error(reply, 400, 'invalid_request', 'Provide a valid owner and relative path');
    }
    if ((cause as { statusCode?: number }).statusCode === 429) {
      return error(reply, 429, 'rate_limited', 'Too many viewing requests');
    }
    request.log.error({ err: cause, request_id: request.id }, 'CLI viewing request failed');
    return error(reply, 500, 'internal_error', 'An unexpected error occurred');
  });

  const querystring = {
    type: 'object',
    properties: { owner: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  };
  app.get('/api/v1/drops/:name/content', {
    preHandler: requireCliToken, schema: { querystring },
  }, async (request, reply) => {
    const target = await resolveDrop(request, reply);
    if (!target) return;
    const found = await getDropContent(target.version, target.path);
    if (!found) return error(reply, 404, 'file_not_found', 'No file exists at that path');
    // Uploaded HTML must never execute with the control plane's origin.
    reply.type('application/octet-stream');
    reply.header('Content-Disposition', 'attachment');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('X-Drops-Content-Type', found.contentType);
    reply.header('X-Drops-Path', encodePath(found.path));
    if (found.contentLength !== undefined) reply.header('Content-Length', found.contentLength);
    return reply.send(found.body);
  });

  app.post('/api/v1/drops/:name/open', {
    preHandler: requireCliToken,
    schema: { querystring },
    config: { skipCsrf: true, ...tightAuthLimit },
  }, async (request, reply) => {
    const target = await resolveDrop(request, reply);
    if (!target) return;
    const origin = dropOriginFor(target.username, target.name);
    const url = origin + '/' + encodePath(target.path);
    const handoff = new URL('/auth/bootstrap', origin);
    handoff.searchParams.set('token', signHandoff(
      `cli:${request.cliToken!.id}`, handoff.hostname, config.SESSION_SECRET, 60,
    ));
    handoff.searchParams.set('next', '/' + encodePath(target.path));
    return { instance: config.APP_ORIGIN, name: target.name, url, openUrl: handoff.href, expiresIn: 60 };
  });
};
