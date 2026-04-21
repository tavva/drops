// ABOUTME: Strict UUID format guard for route boundary validation.
// ABOUTME: Matches any valid canonical UUID (any version); version-strict parsing is not needed here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
