import { describe, it, expect, beforeAll } from 'vitest';
import { Readable } from 'node:stream';
import { resetBucket } from '../helpers/r2';
import { putObject, getObject, deletePrefix, listPrefix, headObject, buildR2Endpoint } from '@/lib/r2';

beforeAll(async () => { await resetBucket(); });

describe('buildR2Endpoint', () => {
  it('uses R2_ENDPOINT when set', () => {
    expect(buildR2Endpoint({ endpoint: 'http://localhost:9000', accountId: 'x' }))
      .toBe('http://localhost:9000');
  });
  it('derives production endpoint from R2_ACCOUNT_ID when endpoint is unset', () => {
    expect(buildR2Endpoint({ endpoint: undefined, accountId: 'acct-123' }))
      .toBe('https://acct-123.r2.cloudflarestorage.com');
  });
});

describe('r2', () => {
  it('puts, gets and heads', async () => {
    await putObject('a/b.txt', Buffer.from('hello'), 'text/plain');
    const head = await headObject('a/b.txt');
    expect(head?.contentType).toBe('text/plain');
    const out = await getObject('a/b.txt');
    const text = await streamToString(out!.body);
    expect(text).toBe('hello');
  });
  it('returns null for missing key', async () => {
    expect(await getObject('does-not-exist')).toBeNull();
    expect(await headObject('does-not-exist')).toBeNull();
  });
  it('lists and deletes a prefix', async () => {
    await putObject('p/x', Buffer.from('1'));
    await putObject('p/y', Buffer.from('2'));
    await putObject('q/z', Buffer.from('3'));
    const keys = await listPrefix('p/');
    expect(keys.sort()).toEqual(['p/x', 'p/y']);
    await deletePrefix('p/');
    expect(await listPrefix('p/')).toEqual([]);
  });
});

async function streamToString(r: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
