import { describe, it, expect } from 'vitest';
import { mimeFor } from '@/lib/mime';

describe('mimeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['script.js', 'application/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['img.png', 'image/png'],
    ['img.JPG', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['thing.unknown', 'application/octet-stream'],
    ['no-ext', 'application/octet-stream'],
    ['.dotfile', 'application/octet-stream'],
  ])('mimeFor(%p) === %p', (name, mime) => {
    expect(mimeFor(name)).toBe(mime);
  });
});
