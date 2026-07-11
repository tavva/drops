// ABOUTME: POST /app/drops/:name/upload — receives folder or zip multipart bodies, commits atomically.
// ABOUTME: Uploads write to a unique drops/<versionId>/ prefix; commit is an ON CONFLICT + FOR UPDATE swap.
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { requireCompletedMember } from '@/middleware/auth';
import { uploadLimit } from '@/middleware/rateLimit';
import { isValidSlug } from '@/lib/slug';
import { uploadFolderParts, UPLOAD_LIMITS, MultipartPart, detectEntryPath } from '@/services/upload';
import { uploadZip } from '@/services/uploadZip';
import { UploadError } from '@/services/uploadErrors';
import { commitDeployment, DeploymentCommitError } from '@/services/deployments';
import { config } from '@/config';

async function* adaptParts(iter: AsyncIterable<unknown>, log: (obj: Record<string, unknown>, msg?: string) => void): AsyncIterable<MultipartPart> {
  for await (const raw of iter) {
    const p = raw as { type?: string; fieldname: string; filename?: string; file?: NodeJS.ReadableStream };
    if (p.type !== 'file' || !p.file) continue;
    log({ filename: p.filename, fieldname: p.fieldname }, 'multipart part');
    yield {
      fieldName: p.fieldname,
      filename: p.filename ?? '',
      file: p.file as unknown as import('node:stream').Readable,
      fields: {},
    };
  }
}

export const uploadRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/upload', { preHandler: requireCompletedMember, config: uploadLimit }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(400).send({ error: 'invalid_name' });

    const q = req.query as { upload_type?: string };
    const uploadType = q.upload_type;
    if (uploadType !== 'folder' && uploadType !== 'zip') {
      return reply.code(400).send({ error: 'invalid_upload_type' });
    }

    const user = req.user!;
    const versionId = randomUUID();
    const r2Prefix = `drops/${versionId}/`;

    let result: Awaited<ReturnType<typeof uploadFolderParts>>;
    try {
      if (uploadType === 'zip') {
        const parts = req.parts({
          limits: { fileSize: UPLOAD_LIMITS.totalBytes, files: 1, parts: 10, fieldNameSize: 200, fieldSize: 1024 },
        });
        let zipStream: NodeJS.ReadableStream | null = null;
        for await (const raw of parts) {
          const p = raw as { type?: string; file?: NodeJS.ReadableStream };
          if (p.type === 'file' && p.file && !zipStream) {
            zipStream = p.file;
            break;
          }
        }
        if (!zipStream) return reply.code(400).send({ error: 'no_file' });
        result = await uploadZip(r2Prefix, zipStream as import('node:stream').Readable);
      } else {
        const parts = req.parts({
          limits: {
            fileSize: UPLOAD_LIMITS.perFileBytes,
            files: UPLOAD_LIMITS.fileCount,
            parts: UPLOAD_LIMITS.fileCount + 10,
            fieldNameSize: 200,
            fieldSize: 1024,
          },
        });
        result = await uploadFolderParts(r2Prefix, adaptParts(parts, (o, m) => req.log.info(o, m)));
      }
    } catch (e) {
      if (e instanceof UploadError) {
        return reply.code(400).send({ error: e.code, message: e.message });
      }
      throw e;
    }

    const entryPath = detectEntryPath(result.files.map((f) => f.path));

    try {
      await commitDeployment({
        ownerId: user.id,
        name,
        versionId,
        r2Prefix,
        result,
        entryPath,
      }, {
        logger: req.log,
      });
    } catch (e) {
      if (e instanceof DeploymentCommitError) {
        return reply.code(500).send({ error: 'commit_failed' });
      }
      throw e;
    }

    // redirect back to the app-side edit page; the drop's live URL is shown there.
    const target = new URL(`/app/drops/${name}`, config.APP_ORIGIN);
    return reply.redirect(target.toString(), 302);
  });
};
