// ABOUTME: Bearer-authenticated read APIs listing a user's own drops and one drop's files.
// ABOUTME: Lookups are owner-scoped; file sizes come from the current version's R2 prefix.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { listPrefixObjects } from '@/lib/r2';
import { isValidSlug } from '@/lib/slug';
import { requireCliToken } from '@/middleware/cliAuth';
import { findByOwnerAndName, listByOwner } from '@/services/drops';

type ApiErrorCode = 'invalid_name' | 'drop_not_found' | 'rate_limited' | 'internal_error';

const messages: Record<ApiErrorCode, string> = {
  invalid_name: 'The drop name must be a valid slug',
  drop_not_found: 'No drop with that name exists for this user',
  rate_limited: 'Too many list requests',
  internal_error: 'An unexpected error occurred',
};

function apiError(reply: FastifyReply, statusCode: number, code: ApiErrorCode) {
  return reply.code(statusCode).send({ error: { code, message: messages[code], details: null } });
}

export const cliListRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? error.statusCode
      : undefined;
    if (statusCode === 429) return apiError(reply, 429, 'rate_limited');
    request.log.error({ err: error, request_id: request.id }, 'CLI list request failed');
    return apiError(reply, 500, 'internal_error');
  });

  app.get('/api/v1/drops', { preHandler: requireCliToken }, async (request) => {
    const summaries = await listByOwner(request.user!.id);
    return {
      instance: config.APP_ORIGIN,
      drops: summaries.map((drop) => ({
        name: drop.name,
        url: dropOriginFor(request.user!.username!, drop.name),
        updatedAt: drop.updatedAt.toISOString(),
        byteSize: drop.version?.byteSize ?? 0,
        fileCount: drop.version?.fileCount ?? 0,
        entryPath: drop.version?.entryPath ?? null,
        versionId: drop.version?.id ?? null,
      })),
    };
  });

  app.get('/api/v1/drops/:name/files', { preHandler: requireCliToken }, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidSlug(name)) return apiError(reply, 400, 'invalid_name');
    const drop = await findByOwnerAndName(request.user!.id, name);
    if (drop === null) return apiError(reply, 404, 'drop_not_found');
    if (drop.version === null) return { instance: config.APP_ORIGIN, name, files: [] };
    const prefix = drop.version.r2Prefix;
    const objects = await listPrefixObjects(prefix);
    return {
      instance: config.APP_ORIGIN,
      name,
      files: objects.map((object) => ({ path: object.key.slice(prefix.length), size: object.size })),
    };
  });
};
