// ABOUTME: Unit tests for folder name validation.
// ABOUTME: Rules: 1-64 NFC chars, trimmed, no control chars, no slashes.
import { describe, it, expect } from 'vitest';
import { cleanFolderName } from '@/lib/folderName';

describe('cleanFolderName', () => {
  it('accepts a plain name and returns it unchanged', () => {
    expect(cleanFolderName('reports')).toBe('reports');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanFolderName('  reports  ')).toBe('reports');
  });

  it('rejects empty/whitespace-only', () => {
    expect(() => cleanFolderName('')).toThrow();
    expect(() => cleanFolderName('   ')).toThrow();
  });

  it('rejects > 64 characters after trim', () => {
    expect(() => cleanFolderName('a'.repeat(65))).toThrow();
  });

  it('accepts exactly 64 characters', () => {
    expect(cleanFolderName('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects forward or back slash', () => {
    expect(() => cleanFolderName('a/b')).toThrow();
    expect(() => cleanFolderName('a\\b')).toThrow();
  });

  it('rejects control characters', () => {
    expect(() => cleanFolderName('a\x00b')).toThrow();
    expect(() => cleanFolderName('a\tb')).toThrow();
    expect(() => cleanFolderName('a\nb')).toThrow();
  });

  it('NFC-normalises composed/decomposed forms', () => {
    const composed = 'é';          // é
    const decomposed = 'é';       // e + combining acute
    expect(cleanFolderName(decomposed)).toBe(composed);
  });
});
