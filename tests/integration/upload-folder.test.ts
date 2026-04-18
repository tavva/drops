import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetBucket } from '../helpers/r2';
import { fromBuffers } from '../helpers/multipart';
import { uploadFolderParts, UPLOAD_LIMITS } from '@/services/upload';
import { UploadError } from '@/services/uploadErrors';
import { getObject, listPrefix } from '@/lib/r2';
import { Readable } from 'node:stream';

beforeAll(async () => { await resetBucket(); });

function prefix() { return `drops/${randomUUID()}/`; }

async function drain(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('uploadFolderParts', () => {
  let p: string;
  beforeEach(() => { p = prefix(); });

  it('uploads a folder to R2', async () => {
    const res = await uploadFolderParts(p, fromBuffers([
      { filename: 'index.html', bytes: Buffer.from('<html>') },
      { filename: 'css/style.css', bytes: Buffer.from('body{}') },
    ]));
    expect(res.fileCount).toBe(2);
    expect(res.totalBytes).toBe(12);
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'css/style.css', p + 'index.html']);
    const html = await getObject(p + 'index.html');
    expect(html?.contentType).toBe('text/html; charset=utf-8');
    expect((await drain(html!.body)).toString()).toBe('<html>');
  });

  it('rejects parent-segment paths and cleans up', async () => {
    await expect(uploadFolderParts(p, fromBuffers([
      { filename: 'index.html', bytes: Buffer.from('<html>') },
      { filename: 'bad/../sneaky.html', bytes: Buffer.from('no') },
    ]))).rejects.toBeInstanceOf(UploadError);
    expect(await listPrefix(p)).toEqual([]);
  });

  it('rejects dotfiles', async () => {
    await expect(uploadFolderParts(p, fromBuffers([
      { filename: 'a/.git/config', bytes: Buffer.from('x') },
    ]))).rejects.toMatchObject({ code: 'path_rejected' });
    expect(await listPrefix(p)).toEqual([]);
  });

  it('enforces per-file size', async () => {
    const big = Buffer.alloc(UPLOAD_LIMITS.perFileBytes + 1, 0);
    await expect(uploadFolderParts(p, fromBuffers([
      { filename: 'big.bin', bytes: big },
    ]))).rejects.toMatchObject({ code: 'per_file_size' });
    expect(await listPrefix(p)).toEqual([]);
  }, 30_000);

  it('enforces total size', async () => {
    const chunk = Buffer.alloc(9 * 1024 * 1024, 0);
    const files = Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}.bin`, bytes: chunk }));
    await expect(uploadFolderParts(p, fromBuffers(files)))
      .rejects.toMatchObject({ code: 'total_size' });
    expect(await listPrefix(p)).toEqual([]);
  }, 60_000);

  it('enforces file count', async () => {
    const files = Array.from({ length: UPLOAD_LIMITS.fileCount + 1 }, (_, i) => ({
      filename: `f${i}.txt`, bytes: Buffer.from('x'),
    }));
    await expect(uploadFolderParts(p, fromBuffers(files)))
      .rejects.toMatchObject({ code: 'file_count' });
    expect(await listPrefix(p)).toEqual([]);
  }, 120_000);

  it('rejects post-canonicalisation collision', async () => {
    await expect(uploadFolderParts(p, fromBuffers([
      { filename: 'a/b', bytes: Buffer.from('1') },
      { filename: './a/b', bytes: Buffer.from('2') },
    ]))).rejects.toMatchObject({ code: 'path_collision' });
    expect(await listPrefix(p)).toEqual([]);
  });
});
