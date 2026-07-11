// ABOUTME: Guards the strict app-host CSP: EJS templates must carry no inline scripts, event
// ABOUTME: handlers, or style attributes (script-src/style-src 'self' would block them silently).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function ejsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return ejsFiles(full);
    return e.name.endsWith('.ejs') ? [full] : [];
  });
}

const files = ejsFiles(join(process.cwd(), 'src/views'));

describe('views are CSP-clean', () => {
  it('finds template files', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('cliAuthorize.ejs'))).toBe(true);
  });

  it.each(files)('%s has no inline script/handler/style', (file) => {
    const content = readFileSync(file, 'utf8');
    expect(content, 'inline <script> without src').not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(content, 'inline style= attribute').not.toMatch(/\sstyle="/);
    expect(content, 'inline on*= handler').not.toMatch(/\son[a-z]+="/);
  });

  it('keeps the CLI approval view free of CSP-blocked remote fonts and preconnects', () => {
    const content = readFileSync(join(process.cwd(), 'src/views/cliAuthorize.ejs'), 'utf8');
    expect(content).not.toContain('fonts.googleapis.com');
    expect(content).not.toContain('fonts.gstatic.com');
    expect(content).not.toContain('rel="preconnect"');
  });
});
