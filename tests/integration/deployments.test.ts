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
import { deleteDropWithPrefixes, findByOwnerAndName } from '@/services/drops';
import { deletePrefix, listPrefix, putObject } from '@/lib/r2';
import { resetBucket } from '../helpers/r2';

let ownerId: string;

beforeEach(async () => {
  await resetBucket();
  await db.delete(users);
  const [user] = await db.insert(users).values({
    email: `${randomUUID()}@example.com`,
    username: 'alice',
  }).returning();
  ownerId = user!.id;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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

  it('lets deletion win when it locked a previously observed drop first', async () => {
    const initial = input();
    await putObject(initial.r2Prefix + 'index.html', Buffer.from('initial'));
    await commitDeployment(initial, { scheduleGc: vi.fn() });
    const replacement = input();
    await putObject(replacement.r2Prefix + 'index.html', Buffer.from('replacement'));
    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deploymentObserved = deferred();

    const deleting = deleteDropWithPrefixes(ownerId, 'site', {
      afterLock: async () => {
        deleteLocked.resolve();
        await releaseDelete.promise;
      },
    });
    await deleteLocked.promise;
    const deploying = commitDeployment(replacement, {
      beforeExistingLock: async () => deploymentObserved.resolve(),
      cleanup: deletePrefix,
      scheduleGc: vi.fn(),
    });
    await deploymentObserved.promise;
    releaseDelete.resolve();

    const deleted = await deleting;
    await expect(deploying).rejects.toBeInstanceOf(DeploymentCommitError);
    for (const prefix of deleted!.prefixes) await deletePrefix(prefix);
    expect(await findByOwnerAndName(ownerId, 'site')).toBeNull();
    expect(await listPrefix(initial.r2Prefix)).toEqual([]);
    expect(await listPrefix(replacement.r2Prefix)).toEqual([]);
  });

  it('includes a replacement in deletion when deployment locked the row first', async () => {
    const initial = input();
    await putObject(initial.r2Prefix + 'index.html', Buffer.from('initial'));
    await commitDeployment(initial, { scheduleGc: vi.fn() });
    const replacement = input();
    await putObject(replacement.r2Prefix + 'index.html', Buffer.from('replacement'));
    const deploymentLocked = deferred();
    const releaseDeployment = deferred();
    const deleteStarted = deferred();

    const deploying = commitDeployment(replacement, {
      afterExistingLock: async () => {
        deploymentLocked.resolve();
        await releaseDeployment.promise;
      },
      scheduleGc: vi.fn(),
    });
    await deploymentLocked.promise;
    const deleting = deleteDropWithPrefixes(ownerId, 'site', {
      beforeLock: async () => deleteStarted.resolve(),
    });
    await deleteStarted.promise;
    releaseDeployment.resolve();

    await deploying;
    const deleted = await deleting;
    expect(deleted!.prefixes).toEqual(expect.arrayContaining([initial.r2Prefix, replacement.r2Prefix]));
    for (const prefix of deleted!.prefixes) await deletePrefix(prefix);
    expect(await findByOwnerAndName(ownerId, 'site')).toBeNull();
    expect(await listPrefix('drops/')).toEqual([]);
  });

  it('serialises concurrent first creation of the same named drop', async () => {
    const a = input();
    const b = input();
    const results = await Promise.all([
      commitDeployment(a, { scheduleGc: vi.fn() }),
      commitDeployment(b, { scheduleGc: vi.fn() }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.dropId))).toEqual(new Set([results[0]!.dropId]));
    const current = await findByOwnerAndName(ownerId, 'site');
    expect([a.versionId, b.versionId]).toContain(current!.currentVersion);
  });

  it('allows a deployment first observed after deletion commits to recreate the name', async () => {
    const initial = input();
    const initialResult = await commitDeployment(initial, { scheduleGc: vi.fn() });
    const deleted = await deleteDropWithPrefixes(ownerId, 'site');
    expect(deleted?.dropId).toBe(initialResult.dropId);

    const replacement = input();
    const recreated = await commitDeployment(replacement, { scheduleGc: vi.fn() });

    expect(recreated.created).toBe(true);
    expect(recreated.dropId).not.toBe(initialResult.dropId);
    expect((await findByOwnerAndName(ownerId, 'site'))!.currentVersion).toBe(replacement.versionId);
  });
});
