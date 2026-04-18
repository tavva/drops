import { describe, it, expect } from 'vitest';
import { sanitisePath, PathRejection } from '@/lib/path';

describe('sanitisePath', () => {
  it.each([
    ['foo/bar.html', 'foo/bar.html'],
    ['./foo.html', 'foo.html'],
    ['FOO/Bar.HTML', 'FOO/Bar.HTML'],
  ])('accepts %p', (input, expected) => {
    expect(sanitisePath(input)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ['', PathRejection.Empty],
    ['/abs/path', PathRejection.AbsolutePath],
    ['C:/x', PathRejection.AbsolutePath],
    ['\\foo', PathRejection.AbsolutePath],
    ['a/../b', PathRejection.ParentSegment],
    ['../b', PathRejection.ParentSegment],
    ['a/./b', PathRejection.DotSegment],
    ['foo//bar.html', PathRejection.DotSegment],
    ['a//.//b', PathRejection.DotSegment],
    ['a/\0/b', PathRejection.ControlChar],
    ['a/b\x01', PathRejection.ControlChar],
    ['.hidden/a', PathRejection.Dotfile],
    ['a/.git/config', PathRejection.Dotfile],
    ['a/.DS_Store', PathRejection.Dotfile],
    ['a/', PathRejection.TrailingSlash],
  ])('rejects %p as %s', (input, reason) => {
    expect(sanitisePath(input)).toEqual({ ok: false, reason });
  });

  it('applies NFC normalisation', () => {
    const combining = 'a\u0301';
    const precomposed = '\u00e1';
    const res = sanitisePath(combining);
    expect(res).toEqual({ ok: true, path: precomposed });
  });
});
