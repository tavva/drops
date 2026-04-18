import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { drops, dropVersions, users } from '@/db/schema';
import { resetBucket } from '../helpers/r2';
import { putObject, listPrefix } from '@/lib/r2';
import { gcVersion, sweepOrphans } from '@/services/gc';
import { createDropAndVersion, replaceVersion } from '@/services/drops';

beforeAll(async () => { await resetBucket(); });

let ownerId: string;
beforeEach(async () => {
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  ownerId = u!.id;
});

describe('gc', () => {
  it('sweepOrphans removes unreferenced versions and leaves current alone', async () => {
    const v1Prefix = `drops/v1/`;
    const v2Prefix = `drops/v2/`;
    await putObject(v1Prefix + 'a.txt', Buffer.from('old'));
    await putObject(v2Prefix + 'a.txt', Buffer.from('new'));
    const first = await createDropAndVersion(ownerId, 'site', {
      r2Prefix: v1Prefix, byteSize: 3, fileCount: 1,
    });
    const second = await replaceVersion(first.dropId, ownerId, {
      r2Prefix: v2Prefix, byteSize: 3, fileCount: 1,
    });
    const swept = await sweepOrphans();
    expect(swept).toBe(1);
    expect(await listPrefix(v1Prefix)).toEqual([]);
    expect(await listPrefix(v2Prefix)).not.toEqual([]);
    const versions = await db.select().from(dropVersions);
    expect(versions.map((v) => v.id)).toEqual([second.newVersionId]);
  });

  it('gcVersion is idempotent on an orphaned version', async () => {
    const v1Prefix = `drops/orphan-v1/`;
    const v2Prefix = `drops/orphan-v2/`;
    await putObject(v1Prefix + 'x', Buffer.from('x'));
    await putObject(v2Prefix + 'x', Buffer.from('x'));
    const first = await createDropAndVersion(ownerId, 'tmp', {
      r2Prefix: v1Prefix, byteSize: 1, fileCount: 1,
    });
    await replaceVersion(first.dropId, ownerId, {
      r2Prefix: v2Prefix, byteSize: 1, fileCount: 1,
    });
    await gcVersion(first.versionId);
    await gcVersion(first.versionId);
    expect(await listPrefix(v1Prefix)).toEqual([]);
  });
});
