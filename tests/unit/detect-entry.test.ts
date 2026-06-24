// ABOUTME: Unit tests for detectEntryPath — choosing a drop's homepage from its file list.
// ABOUTME: Covers root index, single nested index, single html, and ambiguous/no-html cases.
import { describe, it, expect } from 'vitest';
import { detectEntryPath } from '@/services/upload';

describe('detectEntryPath', () => {
  it('returns null when a root index.html exists (default lookup finds it)', () => {
    expect(detectEntryPath(['index.html', 'style.css'])).toBeNull();
  });
  it('picks the sole nested index.html', () => {
    expect(detectEntryPath(['ui_kits/app/index.html', 'assets/x.css'])).toBe('ui_kits/app/index.html');
  });
  it('picks the sole html when there is no index.html', () => {
    expect(detectEntryPath(['Proptics Website.html', 'assets/x.css'])).toBe('Proptics Website.html');
  });
  it('treats .htm like .html', () => {
    expect(detectEntryPath(['home.htm', 'a.css'])).toBe('home.htm');
  });
  it('returns null (ambiguous) for multiple root htmls', () => {
    expect(detectEntryPath(['Home.html', 'About.html'])).toBeNull();
  });
  it('returns null (ambiguous) for multiple index.html', () => {
    expect(detectEntryPath(['a/index.html', 'b/index.html'])).toBeNull();
  });
  it('returns null when there is no html at all', () => {
    expect(detectEntryPath(['doc.pdf', 'img.png'])).toBeNull();
  });
});
