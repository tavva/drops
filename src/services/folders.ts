// ABOUTME: Folder CRUD + tree operations. Structural mutations take a transaction-scoped advisory lock.
// ABOUTME: resolveReparentName is exported for unit testing of the delete-time collision rule.
const MAX_NAME = 64;

export function resolveReparentName(base: string, deletedParentName: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  const openSuffix = ' (from ';
  const closeSuffix = ')';
  const overhead = openSuffix.length + closeSuffix.length; // 9
  const parentBudget = MAX_NAME - overhead - 1;           // leave at least 1 char for the base
  const parentPart = deletedParentName.length > parentBudget
    ? deletedParentName.slice(0, Math.max(0, parentBudget - 1)) + '…'
    : deletedParentName;
  const fromSuffix = `${openSuffix}${parentPart}${closeSuffix}`;

  function fit(name: string): string {
    if (name.length <= MAX_NAME) return name;
    const keep = Math.max(1, MAX_NAME - fromSuffix.length);
    return name.slice(0, keep) + fromSuffix;
  }

  const withFrom = fit(base + fromSuffix);
  if (!taken.has(withFrom)) return withFrom;

  for (let n = 1; n < 10_000; n++) {
    const nSuffix = ` (${n})`;
    const cap = MAX_NAME - nSuffix.length;
    const body = withFrom.length > cap ? withFrom.slice(0, cap) : withFrom;
    const candidate = body + nSuffix;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('could not resolve reparent name — too many collisions');
}
