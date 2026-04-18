import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { resetBucket } from '../helpers/r2';
import { uploadZip } from '@/services/uploadZip';
import { UploadError } from '@/services/uploadErrors';
import { listPrefix, getObject } from '@/lib/r2';

beforeAll(async () => { await resetBucket(); });

function prefix() { return `drops/${randomUUID()}/`; }

async function zipToBuffer(z: yazl.ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
    z.end();
  });
}

async function drain(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function makeZip(entries: Array<{ name: string; data: Buffer; mode?: number; dir?: boolean }>): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const e of entries) {
    if (e.dir) {
      z.addEmptyDirectory(e.name);
    } else {
      z.addBuffer(e.data, e.name, e.mode !== undefined ? { mode: e.mode } : {});
    }
  }
  return zipToBuffer(z);
}

describe('uploadZip', () => {
  let p: string;
  beforeEach(() => { p = prefix(); });

  it('uploads a zip to R2', async () => {
    const zip = await makeZip([
      { name: 'index.html', data: Buffer.from('<html>') },
      { name: 'css/style.css', data: Buffer.from('body{}') },
    ]);
    const res = await uploadZip(p, Readable.from([zip]));
    expect(res.fileCount).toBe(2);
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'css/style.css', p + 'index.html']);
    const obj = await getObject(p + 'index.html');
    expect((await drain(obj!.body)).toString()).toBe('<html>');
  });

  it('unwraps a single-root zip', async () => {
    const zip = await makeZip([
      { name: 'my-site/', dir: true },
      { name: 'my-site/index.html', data: Buffer.from('<html>') },
      { name: 'my-site/css/style.css', data: Buffer.from('body{}') },
    ]);
    await uploadZip(p, Readable.from([zip]));
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'css/style.css', p + 'index.html']);
  });

  it('rejects zip symlink entries', async () => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('../target'), 'link', { mode: 0o120777 });
    const zip = await zipToBuffer(z);
    await expect(uploadZip(p, Readable.from([zip])))
      .rejects.toMatchObject({ code: 'zip_symlink' });
    expect(await listPrefix(p)).toEqual([]);
  });

  it('rejects parent-segment paths in zip', async () => {
    const zip = buildRawZip('a/../b.html', Buffer.from('no'));
    await expect(uploadZip(p, Readable.from([zip])))
      .rejects.toBeInstanceOf(UploadError);
    expect(await listPrefix(p)).toEqual([]);
  });

  it('rejects a corrupt archive', async () => {
    await expect(uploadZip(p, Readable.from([Buffer.from('not a zip')])))
      .rejects.toMatchObject({ code: 'invalid_zip' });
    expect(await listPrefix(p)).toEqual([]);
  });

  it('rejects post-canonicalisation path collision in zip', async () => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('1'), 'a/b');
    z.addBuffer(Buffer.from('2'), './a/b');
    const zip = await zipToBuffer(z);
    await expect(uploadZip(p, Readable.from([zip])))
      .rejects.toMatchObject({ code: 'path_collision' });
    expect(await listPrefix(p)).toEqual([]);
  });

  it('blocks a zip bomb', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0);
    const zip = await makeZip([{ name: 'bomb.bin', data: big }]);
    await expect(uploadZip(p, Readable.from([zip])))
      .rejects.toMatchObject({ code: 'zip_bomb' });
    expect(await listPrefix(p)).toEqual([]);
  }, 60_000);

  it('rejects a zip too large to spool', async () => {
    const chunks: Buffer[] = [];
    for (let i = 0; i < 102; i++) chunks.push(Buffer.alloc(1 * 1024 * 1024, 0));
    await expect(uploadZip(p, Readable.from(chunks)))
      .rejects.toMatchObject({ code: 'zip_too_large' });
    expect(await listPrefix(p)).toEqual([]);
  }, 60_000);
});

function buildRawZip(filename: string, data: Buffer): Buffer {
  // Stored (uncompressed) zip with a single entry. Bypasses yazl's filename validation.
  const nameBytes = Buffer.from(filename, 'utf8');
  const crc32 = (() => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i]!;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  })();
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(0x0314, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc32, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const cdOffset = localHeader.length + nameBytes.length + data.length;
  const cdSize = centralHeader.length + nameBytes.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, nameBytes, data, centralHeader, nameBytes, eocd]);
}
