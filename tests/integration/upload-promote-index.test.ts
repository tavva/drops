// ABOUTME: Verifies that a lone root-level .html is renamed to index.html after upload.
// ABOUTME: Covers the rename conditions and the negative cases that must leave files untouched.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetBucket } from '../helpers/r2';
import { fromBuffers } from '../helpers/multipart';
import { uploadFolderParts, promoteSingleHtmlToIndex } from '@/services/upload';
import { getObject, listPrefix } from '@/lib/r2';
import { Readable } from 'node:stream';

beforeAll(async () => { await resetBucket(); });

function prefix() { return `drops/${randomUUID()}/`; }

async function drain(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('promoteSingleHtmlToIndex', () => {
  let p: string;
  beforeEach(() => { p = prefix(); });

  it('renames a lone root-level .html to index.html', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'about.html', bytes: Buffer.from('<html>about</html>') },
      { filename: 'css/style.css', bytes: Buffer.from('body{}') },
      { filename: 'img/logo.png', bytes: Buffer.from('PNGDATA') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path).sort()).toEqual([
      'css/style.css',
      'img/logo.png',
      'index.html',
    ]);
    expect(res.fileCount).toBe(3);
    expect(res.totalBytes).toBe(uploaded.totalBytes);

    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([
      p + 'css/style.css',
      p + 'img/logo.png',
      p + 'index.html',
    ]);

    const idx = await getObject(p + 'index.html');
    expect(idx?.contentType).toBe('text/html; charset=utf-8');
    expect((await drain(idx!.body)).toString()).toBe('<html>about</html>');
  });

  it('does nothing when index.html already exists', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'index.html', bytes: Buffer.from('<html>home</html>') },
      { filename: 'about.html', bytes: Buffer.from('<html>about</html>') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path).sort()).toEqual(['about.html', 'index.html']);
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'about.html', p + 'index.html']);
  });

  it('does nothing when multiple .html files exist', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'about.html', bytes: Buffer.from('a') },
      { filename: 'contact.html', bytes: Buffer.from('c') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path).sort()).toEqual(['about.html', 'contact.html']);
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'about.html', p + 'contact.html']);
  });

  it('does nothing when the single .html is in a subdirectory', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'docs/manual.html', bytes: Buffer.from('<html>doc</html>') },
      { filename: 'readme.txt', bytes: Buffer.from('hi') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path).sort()).toEqual(['docs/manual.html', 'readme.txt']);
    const keys = (await listPrefix(p)).sort();
    expect(keys).toEqual([p + 'docs/manual.html', p + 'readme.txt']);
  });

  it('does nothing when there are no .html files', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'readme.txt', bytes: Buffer.from('hi') },
      { filename: 'data.json', bytes: Buffer.from('{}') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path).sort()).toEqual(['data.json', 'readme.txt']);
  });

  it('renames a file with spaces in its name', async () => {
    const uploaded = await uploadFolderParts(p, fromBuffers([
      { filename: 'my page.html', bytes: Buffer.from('<html>x</html>') },
    ]));
    const res = await promoteSingleHtmlToIndex(p, uploaded);

    expect(res.files.map((f) => f.path)).toEqual(['index.html']);
    const keys = await listPrefix(p);
    expect(keys).toEqual([p + 'index.html']);
    const idx = await getObject(p + 'index.html');
    expect((await drain(idx!.body)).toString()).toBe('<html>x</html>');
  });
});
