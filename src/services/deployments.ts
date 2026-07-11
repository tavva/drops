// ABOUTME: Transport-independent atomic deployment commit and old-version GC scheduling.
// ABOUTME: A failed database commit immediately best-effort removes the completed upload prefix.
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { drops, dropVersions } from '@/db/schema';
import { deletePrefix } from '@/lib/r2';
import { gcVersion } from '@/services/gc';
import type { UploadResult } from '@/services/upload';

export interface DeploymentInput {
  ownerId: string;
  name: string;
  versionId: string;
  r2Prefix: string;
  result: UploadResult;
  entryPath: string | null;
}

export interface DeploymentResult {
  dropId: string;
  versionId: string;
  oldVersionId: string | null;
  created: boolean;
}

interface DeploymentLogger {
  error(obj: Record<string, unknown>, message: string): void;
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface DeploymentDependencies {
  cleanup?: (prefix: string) => Promise<void>;
  logger?: DeploymentLogger;
  scheduleGc?: (versionId: string) => void;
  beforeExistingLock?: () => Promise<void>;
  afterExistingLock?: () => Promise<void>;
}

const silentLogger: DeploymentLogger = {
  error: () => undefined,
  warn: () => undefined,
};

export class DeploymentCommitError extends Error {
  readonly code = 'commit_failed' as const;

  constructor(options?: ErrorOptions) {
    super('Deployment commit failed', options);
    this.name = 'DeploymentCommitError';
  }
}

export async function commitDeployment(
  input: DeploymentInput,
  dependencies: DeploymentDependencies = {},
): Promise<DeploymentResult> {
  const logger = dependencies.logger ?? silentLogger;
  let committed: Omit<DeploymentResult, 'versionId'>;

  try {
    committed = await db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const observed = await tx.execute<{ id: string }>(sql`
        SELECT id FROM drops WHERE owner_id = ${input.ownerId} AND name = ${input.name}
      `);
      let dropId: string;
      let oldVersionId: string | null = null;
      let created = false;
      if (observed[0]) {
        await dependencies.beforeExistingLock?.();
        const existing = await tx.execute<{ id: string; current_version: string | null }>(sql`
          SELECT id, current_version FROM drops
          WHERE id = ${observed[0].id} AND owner_id = ${input.ownerId} AND name = ${input.name}
          FOR UPDATE
        `);
        const row = existing[0];
        if (!row) throw new Error('drop deleted during deployment');
        dropId = row.id;
        oldVersionId = row.current_version;
        await dependencies.afterExistingLock?.();
      } else {
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO drops (owner_id, name) VALUES (${input.ownerId}, ${input.name})
          ON CONFLICT (owner_id, name) DO NOTHING
          RETURNING id
        `);
        if (inserted[0]) {
          created = true;
          dropId = inserted[0].id;
        } else {
          const existing = await tx.execute<{ id: string; current_version: string | null }>(sql`
            SELECT id, current_version FROM drops
            WHERE owner_id = ${input.ownerId} AND name = ${input.name}
            FOR UPDATE
          `);
          const row = existing[0];
          if (!row) throw new Error('drop row vanished');
          dropId = row.id;
          oldVersionId = row.current_version;
        }
      }

      await tx.insert(dropVersions).values({
        id: input.versionId,
        dropId,
        r2Prefix: input.r2Prefix,
        byteSize: input.result.totalBytes,
        fileCount: input.result.fileCount,
        entryPath: input.entryPath,
      });
      await tx.update(drops)
        .set({ currentVersion: input.versionId, updatedAt: new Date() })
        .where(sql`${drops.id} = ${dropId}`);

      return { dropId, oldVersionId, created };
    });
  } catch (error) {
    logger.error({ err: error, prefix: input.r2Prefix }, 'deployment commit failed');
    try {
      await (dependencies.cleanup ?? deletePrefix)(input.r2Prefix);
    } catch (cleanupError) {
      logger.warn({ err: cleanupError, prefix: input.r2Prefix }, 'deployment cleanup failed');
    }
    throw new DeploymentCommitError({ cause: error });
  }

  if (committed.oldVersionId) {
    const oldVersionId = committed.oldVersionId;
    try {
      if (dependencies.scheduleGc) {
        dependencies.scheduleGc(oldVersionId);
      } else {
        setImmediate(() => {
          gcVersion(oldVersionId).catch((error) => {
            logger.warn({ err: error, id: oldVersionId }, 'async gc failed');
          });
        });
      }
    } catch (error) {
      logger.warn({ err: error, id: oldVersionId }, 'async gc scheduling failed');
    }
  }

  return { ...committed, versionId: input.versionId };
}
