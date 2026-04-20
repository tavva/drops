// ABOUTME: Unit tests for drop-host parse/build helpers under the content root domain.
// ABOUTME: Uses TEST_ENV's CONTENT_ORIGIN = http://content.localtest.me:3000, so root = content.localtest.me.
import { describe, it, expect } from 'vitest';
import '../helpers/env';
import { parseDropHost, dropHostFor, dropOriginFor, contentRootDomain } from '@/lib/dropHost';

describe('contentRootDomain', () => {
  it('derives from CONTENT_ORIGIN hostname', () => {
    expect(contentRootDomain()).toBe('content.localtest.me');
  });
});

describe('dropHostFor', () => {
  it('joins <user>--<drop>.<root>', () => {
    expect(dropHostFor('alice', 'foo')).toBe('alice--foo.content.localtest.me');
  });
  it('lowercases the root if a custom one is passed', () => {
    expect(dropHostFor('alice', 'foo', 'ROOT.EXAMPLE.COM')).toBe('alice--foo.ROOT.EXAMPLE.COM');
    // callers should pass a pre-lowercased root; the function itself is a pure join.
  });
});

describe('dropOriginFor', () => {
  it('preserves CONTENT_ORIGIN protocol and port', () => {
    expect(dropOriginFor('alice', 'foo')).toBe('http://alice--foo.content.localtest.me:3000');
  });
});

describe('parseDropHost', () => {
  it('parses a valid drop host', () => {
    expect(parseDropHost('alice--foo.content.localtest.me')).toEqual({ username: 'alice', dropname: 'foo' });
  });
  it('ignores a :port suffix', () => {
    expect(parseDropHost('alice--foo.content.localtest.me:3000')).toEqual({ username: 'alice', dropname: 'foo' });
  });
  it('is case-insensitive on input but output stays lowercased', () => {
    expect(parseDropHost('ALICE--FOO.Content.Localtest.ME')).toEqual({ username: 'alice', dropname: 'foo' });
  });
  it('rejects the bare apex', () => {
    expect(parseDropHost('content.localtest.me')).toBeNull();
  });
  it('rejects a different domain', () => {
    expect(parseDropHost('alice--foo.evil.com')).toBeNull();
  });
  it('rejects undefined / empty', () => {
    expect(parseDropHost(undefined)).toBeNull();
    expect(parseDropHost('')).toBeNull();
  });
  it('rejects a subdomain that is not <slug>--<slug>', () => {
    expect(parseDropHost('alice.content.localtest.me')).toBeNull();
    expect(parseDropHost('alice-foo.content.localtest.me')).toBeNull();
    expect(parseDropHost('alice---foo.content.localtest.me')).toBeNull();
  });
  it('rejects slugs that break isValidSlug shape (leading/trailing hyphen, too short)', () => {
    expect(parseDropHost('-alice--foo.content.localtest.me')).toBeNull();
    expect(parseDropHost('alice---foo.content.localtest.me')).toBeNull();
    expect(parseDropHost('a--foo.content.localtest.me')).toBeNull();   // user too short
    expect(parseDropHost('alice--b.content.localtest.me')).toBeNull();  // drop too short
  });
  it('rejects an extra subdomain level', () => {
    expect(parseDropHost('foo.alice--bar.content.localtest.me')).toBeNull();
  });
  it('round-trips with dropHostFor', () => {
    const host = dropHostFor('carol-23', 'landing-page');
    expect(parseDropHost(host)).toEqual({ username: 'carol-23', dropname: 'landing-page' });
  });
});
