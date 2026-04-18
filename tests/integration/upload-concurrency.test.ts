import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetBucket } from '../helpers/r2';
import { fromBuffers } from '../helpers/multipart';
import { uploadFolderParts } from '@/services/upload';
import * as r2Mod from '@/lib/r2';
import { listPrefix } from '@/lib/r2';

beforeAll(async () => { await resetBucket(); });

describe('upload concurrency and cleanup', () => {
  it('mid-upload R2 failure leaves no objects behind', async () => {
    const p = `drops/${randomUUID()}/`;
    const realSend = r2Mod.s3.send.bind(r2Mod.s3);
    let count = 0;
    const spy = vi.spyOn(r2Mod.s3, 'send').mockImplementation((cmd: Parameters<typeof realSend>[0]) => {
      if (cmd.constructor.name === 'PutObjectCommand') {
        count++;
        if (count === 2) return Promise.reject(new Error('synthetic R2 failure')) as unknown as ReturnType<typeof realSend>;
      }
      return realSend(cmd) as unknown as ReturnType<typeof realSend>;
    });
    try {
      await expect(uploadFolderParts(p, fromBuffers([
        { filename: 'a.txt', bytes: Buffer.from('1') },
        { filename: 'b.txt', bytes: Buffer.from('2') },
        { filename: 'c.txt', bytes: Buffer.from('3') },
      ]))).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await listPrefix(p)).toEqual([]);
  });

  it('two concurrent folder uploads use distinct prefixes', async () => {
    const p1 = `drops/${randomUUID()}/`;
    const p2 = `drops/${randomUUID()}/`;
    const [res1, res2] = await Promise.all([
      uploadFolderParts(p1, fromBuffers([{ filename: 'x.txt', bytes: Buffer.from('one') }])),
      uploadFolderParts(p2, fromBuffers([{ filename: 'x.txt', bytes: Buffer.from('two') }])),
    ]);
    expect(res1.fileCount).toBe(1);
    expect(res2.fileCount).toBe(1);
    expect((await listPrefix(p1)).sort()).toEqual([p1 + 'x.txt']);
    expect((await listPrefix(p2)).sort()).toEqual([p2 + 'x.txt']);
  });
});
