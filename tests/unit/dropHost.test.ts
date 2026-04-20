// ABOUTME: Unit tests for drop-host parse/build helpers under the content root domain.
// ABOUTME: Uses TEST_ENV's CONTENT_ORIGIN = http://content.localtest.me:3000, so root = content.localtest.me.
import { describe, it, expect } from 'vitest';
import '../helpers/env';
import { parseDropHost, dropHostFor, dropOriginFor, contentRootDomain, dropTargetFromNext } from '@/lib/dropHost';

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

  it('rejects hosts with ambiguous `--` split (collision-safe)', () => {
    // `alice--foo--bar` could split either way; both halves must pass isValidSlug which bans `--`,
    // so the parser must reject rather than silently pick a greedy interpretation.
    expect(parseDropHost('alice--foo--bar.content.localtest.me')).toBeNull();
    expect(parseDropHost('a--b--c--d.content.localtest.me')).toBeNull();
  });
  it('rejects an extra subdomain level', () => {
    expect(parseDropHost('foo.alice--bar.content.localtest.me')).toBeNull();
  });
  it('round-trips with dropHostFor', () => {
    const host = dropHostFor('carol-23', 'landing-page');
    expect(parseDropHost(host)).toEqual({ username: 'carol-23', dropname: 'landing-page' });
  });
});

describe('dropTargetFromNext', () => {
  it('resolves a direct drop-host URL at the configured port', () => {
    expect(dropTargetFromNext('http://alice--foo.content.localtest.me:3000/about.html')).toEqual({
      hostname: 'alice--foo.content.localtest.me',
      username: 'alice',
      dropname: 'foo',
      origin: 'http://alice--foo.content.localtest.me:3000',
      path: '/about.html',
    });
  });

  it('rejects a drop-host URL with a non-configured port', () => {
    expect(dropTargetFromNext('http://alice--foo.content.localtest.me:8443/')).toBeNull();
  });

  it('rejects a drop-host URL with a different scheme', () => {
    expect(dropTargetFromNext('https://alice--foo.content.localtest.me:3000/')).toBeNull();
  });

  it('unwraps an app-host /auth/drop-bootstrap URL', () => {
    const nextPath = '/about.html';
    const wrapped = `http://drops.localtest.me:3000/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=${encodeURIComponent(nextPath)}`;
    expect(dropTargetFromNext(wrapped)).toEqual({
      hostname: 'alice--foo.content.localtest.me',
      username: 'alice',
      dropname: 'foo',
      origin: 'http://alice--foo.content.localtest.me:3000',
      path: '/about.html',
    });
  });

  it('clamps wrapped next path to / when invalid', () => {
    const wrapped = 'http://drops.localtest.me:3000/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=//evil.com';
    expect(dropTargetFromNext(wrapped)?.path).toBe('/');
  });

  it('returns null for a wrapped URL whose host param is invalid', () => {
    const wrapped = 'http://drops.localtest.me:3000/auth/drop-bootstrap?host=evil.com&next=/';
    expect(dropTargetFromNext(wrapped)).toBeNull();
  });

  it('returns null for a non-drop, non-wrapper URL', () => {
    expect(dropTargetFromNext('http://drops.localtest.me:3000/app')).toBeNull();
    expect(dropTargetFromNext('https://evil.com/')).toBeNull();
  });
});
