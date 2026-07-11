// ABOUTME: Integration coverage for the shared atomic deployment commit service.
// ABOUTME: Exercises create, replace, concurrency, post-commit GC, and failed-commit cleanup semantics.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drops, dropVersions, users } from '@/db/schema';
import {
  commitDeployment,
  DeploymentCommitError,
  type DeploymentInput,
} from '@/services/deployments';

let ownerId: string;

beforeEach(async () => {
  await db.delete(users);
  const [user] = await db.insert(users).values({
    email: `${randomUUID()}@example.com`,
    username: 'alice',
  }).returning();
  ownerId = user!.id;
});

function input(overrides: Partial<DeploymentInput> = {}): DeploymentInput {
  const versionId = randomUUID();
  return {
    ownerId,
    name: 'site',
    versionId,
    r2Prefix: `drops/${versionId}/`,
    result: {
      files: [{ path: 'index.html', bytes: 12 }],
      fileCount: 1,
      totalBytes: 12,
    },
    entryPath: null,
    ...overrides,
  };
}

describe('commitDeployment', () => {
  it('creates a drop and makes the uploaded version current', async () => {
    const deployment = input();
    const result = await commitDeployment(deployment, { scheduleGc: vi.fn() });

    expect(result).toMatchObject({
      created: true,
      oldVersionId: null,
      versionId: deployment.versionId,
    });
    const [drop] = await db.select().from(drops).where(eq(drops.id, result.dropId));
    expect(drop).toMatchObject({
      ownerId,
      name: 'site',
      currentVersion: deployment.versionId,
    });
    const [version] = await db.select().from(dropVersions).where(eq(dropVersions.id, deployment.versionId));
    expect(version).toMatchObject({
      dropId: result.dropId,
      r2Prefix: deployment.r2Prefix,
      byteSize: 12,
      fileCount: 1,
      entryPath: null,
    });
  });

  it('replaces an existing current version and schedules its GC only after commit', async () => {
    const first = input();
    const firstResult = await commitDeployment(first, { scheduleGc: vi.fn() });
    const scheduled: string[] = [];
    const second = input({ entryPath: 'docs/index.html' });

    const secondResult = await commitDeployment(second, {
      scheduleGc: (versionId) => {
        scheduled.push(versionId);
      },
    });

    expect(secondResult).toMatchObject({
      created: false,
      dropId: firstResult.dropId,
      oldVersionId: first.versionId,
      versionId: second.versionId,
    });
    expect(scheduled).toEqual([first.versionId]);
    const [drop] = await db.select().from(drops).where(eq(drops.id, firstResult.dropId));
    expect(drop!.currentVersion).toBe(second.versionId);
  });

  it('serialises concurrent replacements with a valid current-version foreign key', async () => {
    const initial = input();
    const initialResult = await commitDeployment(initial, { scheduleGc: vi.fn() });
    const a = input();
    const b = input();

    const results = await Promise.all([
      commitDeployment(a, { scheduleGc: vi.fn() }),
      commitDeployment(b, { scheduleGc: vi.fn() }),
    ]);

    const [drop] = await db.select().from(drops).where(eq(drops.id, initialResult.dropId));
    expect([a.versionId, b.versionId]).toContain(drop!.currentVersion);
    const [validReference] = await db.execute<{ valid: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM drop_versions
        WHERE id = ${drop!.currentVersion} AND drop_id = ${drop!.id}
      ) AS valid
    `);
    expect(validReference!.valid).toBe(true);
    const winningResult = results.find((candidate) => candidate.versionId === drop!.currentVersion);
    expect(winningResult?.oldVersionId).toBe(results.find((candidate) => candidate !== winningResult)?.versionId);
  });

  it('preserves the old current version and cleans the new prefix when commit fails', async () => {
    const initial = input();
    const initialResult = await commitDeployment(initial, { scheduleGc: vi.fn() });
    const cleanup = vi.fn(async () => undefined);
    const scheduleGc = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const failed = input({ versionId: 'not-a-uuid', r2Prefix: 'drops/failed/' });

    await expect(commitDeployment(failed, { cleanup, scheduleGc, logger }))
      .rejects.toBeInstanceOf(DeploymentCommitError);

    expect(cleanup).toHaveBeenCalledExactlyOnceWith('drops/failed/');
    expect(scheduleGc).not.toHaveBeenCalled();
    const [drop] = await db.select().from(drops).where(eq(drops.id, initialResult.dropId));
    expect(drop!.currentVersion).toBe(initial.versionId);
  });

  it('logs cleanup failure without masking the typed commit error', async () => {
    const cleanupFailure = new Error('cleanup failed');
    const logger = { error: vi.fn(), warn: vi.fn() };

    await expect(commitDeployment(input({ versionId: 'bad', r2Prefix: 'drops/bad/' }), {
      cleanup: vi.fn(async () => { throw cleanupFailure; }),
      scheduleGc: vi.fn(),
      logger,
    })).rejects.toMatchObject({ code: 'commit_failed' });

    expect(logger.warn).toHaveBeenCalledWith(
      { err: cleanupFailure, prefix: 'drops/bad/' },
      'deployment cleanup failed',
    );
  });
});
