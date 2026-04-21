// ABOUTME: Unit tests for the client-side upload ignore list (OS metadata filter).
// ABOUTME: Exercises the pure `shouldIgnore` function shared by the folder and zip flows.
import { describe, it, expect } from 'vitest';
import { shouldIgnore } from '../../src/views/static/upload-ignore.js';

describe('shouldIgnore', () => {
  it.each([
    '.DS_Store',
    'sub/.DS_Store',
    'a/b/c/.DS_Store',
    'Thumbs.db',
    'dir/Thumbs.db',
    'desktop.ini',
    'dir/desktop.ini',
    '__MACOSX/foo',
    '__MACOSX/sub/bar',
    'site/__MACOSX/bar',
    '.AppleDouble/foo',
    'site/.AppleDouble/bar',
  ])('ignores %p', (path) => {
    expect(shouldIgnore(path)).toBe(true);
  });

  it.each([
    'index.html',
    'assets/logo.png',
    '.git/config',
    '.gitignore',
    '.env',
    '.well-known/acme-challenge/token',
    'some/ds_store.txt',
    'DS_Store',
    'thumbs_db.html',
  ])('does not ignore %p', (path) => {
    expect(shouldIgnore(path)).toBe(false);
  });
});
