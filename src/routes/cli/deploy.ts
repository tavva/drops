// ABOUTME: Bearer-authenticated raw ZIP deployment API for local CLI clients.
// ABOUTME: Streams archives through uploadZip, then delegates the atomic version swap to deployments.
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { deletePrefix } from '@/lib/r2';
import { isValidSlug } from '@/lib/slug';
import { requireCliToken } from '@/middleware/cliAuth';
import { uploadLimit } from '@/middleware/rateLimit';
import { commitDeployment, DeploymentCommitError } from '@/services/deployments';
import { detectEntryPath, UPLOAD_LIMITS } from '@/services/upload';
import { UploadError, type UploadErrorCode } from '@/services/uploadErrors';
import { uploadZip } from '@/services/uploadZip';

type ApiErrorCode =
  | 'invalid_name'
  | 'invalid_content_type'
  | 'length_required'
  | 'invalid_content_length'
  | 'content_length_mismatch'
  | 'payload_too_large'
  | 'rate_limited'
  | 'commit_failed'
  | 'internal_error'
  | UploadErrorCode;

const messages: Record<ApiErrorCode, string> = {
  invalid_name: 'The drop name must be a valid slug',
  invalid_content_type: 'Content-Type must be application/zip',
  length_required: 'Content-Length is required',
  invalid_content_length: 'Content-Length must be an exact non-negative integer',
  content_length_mismatch: 'The request body does not match Content-Length',
  payload_too_large: 'The compressed archive exceeds the 100 MB limit',
  rate_limited: 'Too many deployment requests',
  commit_failed: 'The deployment could not be committed',
  internal_error: 'An unexpected error occurred',
  per_file_size: 'A file exceeds the upload size limit',
  total_size: 'The uncompressed archive exceeds the upload size limit',
  file_count: 'The archive contains too many files',
  path_rejected: 'The archive contains an invalid path',
  path_collision: 'The archive contains duplicate paths',
  invalid_zip: 'The request body is not a valid ZIP archive',
  zip_symlink: 'ZIP archives may not contain symbolic links',
  zip_bomb: 'The ZIP archive exceeds the safe compression ratio',
  zip_too_large: 'The compressed archive exceeds the 100 MB limit',
};

function apiError(reply: FastifyReply, statusCode: number, code: ApiErrorCode) {
  return reply.code(statusCode).send({ error: { code, message: messages[code], details: null } });
}

function uploadErrorStatus(code: UploadErrorCode): 400 | 413 {
  return ['per_file_size', 'total_size', 'file_count', 'zip_too_large'].includes(code) ? 413 : 400;
}

function parseContentLength(value: string | undefined): { ok: true; value: number } | { ok: false; missing: boolean } {
  if (value === undefined) return { ok: false, missing: true };
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return { ok: false, missing: false };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { ok: false, missing: false };
  return { ok: true, value: parsed };
}

function countedStream(source: Readable): { stream: Readable; received: () => number } {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  source.on('error', (error) => counter.destroy(error));
  source.pipe(counter);
  return { stream: counter, received: () => bytes };
}

async function cleanupMismatch(prefix: string, request: { log: { warn: (obj: Record<string, unknown>, message: string) => void } }) {
  try {
    await deletePrefix(prefix);
  } catch (error) {
    request.log.warn({ err: error, prefix }, 'deployment request cleanup failed');
  }
}

interface CliDeployRouteOptions {
  commit?: typeof commitDeployment;
}

export const cliDeployRoute: FastifyPluginAsync<CliDeployRouteOptions> = async (app, options) => {
  const commit = options.commit ?? commitDeployment;
  app.addContentTypeParser('application/zip', (_request, payload, done) => {
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? error.statusCode
      : undefined;
    if (statusCode === 415) return apiError(reply, 400, 'invalid_content_type');
    if (statusCode === 413) return apiError(reply, 413, 'payload_too_large');
    if (statusCode === 429) return apiError(reply, 429, 'rate_limited');
    request.log.error({ err: error, request_id: request.id }, 'CLI deployment request failed');
    return apiError(reply, 500, 'internal_error');
  });

  app.post('/api/v1/drops/:name/deployments', {
    bodyLimit: UPLOAD_LIMITS.totalBytes,
    preHandler: requireCliToken,
    config: { skipCsrf: true, ...uploadLimit },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidSlug(name)) return apiError(reply, 400, 'invalid_name');

    const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/zip') return apiError(reply, 400, 'invalid_content_type');

    const parsedLength = parseContentLength(request.headers['content-length']);
    if (!parsedLength.ok) {
      return apiError(reply, parsedLength.missing ? 411 : 400, parsedLength.missing ? 'length_required' : 'invalid_content_length');
    }
    if (parsedLength.value > UPLOAD_LIMITS.totalBytes) return apiError(reply, 413, 'payload_too_large');

    const user = request.user!;
    const versionId = randomUUID();
    const r2Prefix = `drops/${versionId}/`;
    const counted = countedStream(request.body as Readable);
    let result: Awaited<ReturnType<typeof uploadZip>>;
    try {
      result = await uploadZip(r2Prefix, counted.stream);
    } catch (error) {
      if (error instanceof UploadError) return apiError(reply, uploadErrorStatus(error.code), error.code);
      throw error;
    }

    if (counted.received() !== parsedLength.value) {
      await cleanupMismatch(r2Prefix, request);
      return apiError(reply, 400, 'content_length_mismatch');
    }

    const entryPath = detectEntryPath(result.files.map((file) => file.path));
    try {
      await commit({
        ownerId: user.id,
        name,
        versionId,
        r2Prefix,
        result,
        entryPath,
      }, { logger: request.log });
    } catch (error) {
      if (error instanceof DeploymentCommitError) return apiError(reply, 500, 'commit_failed');
      throw error;
    }

    return reply.code(201).send({
      instance: config.APP_ORIGIN,
      name,
      url: dropOriginFor(user.username!, name),
      versionId,
      fileCount: result.fileCount,
      byteSize: result.totalBytes,
      entryPath,
    });
  });
};
