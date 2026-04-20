// ABOUTME: Username/drop-name slug validation and suggestion.
// ABOUTME: Slugs are a-z0-9 with internal single hyphens, length 2-32. Consecutive hyphens are banned so '--' can unambiguously separate user/drop in the per-drop host format.
export const SLUG_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'app', 'auth', 'api', 'static', 'admin', '_next', 'health',
  'favicon.ico', 'robots.txt',
]);

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function suggestSlug(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (cleaned.length >= 2 && isValidSlug(cleaned)) return cleaned;
  return 'user';
}
