# Drop folders implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let members create, rename, move, and delete folders on the dashboard, and file any visible drop into a folder. Shared namespace, unbounded nesting, single-parent drops; see `docs/plans/2026-04-21-drop-folders-design.md` for full decisions.

**Architecture:** New `folders` table with `parent_id` self-FK; `drops.folder_id` nullable FK. All folder-structure mutations take a transaction-scoped advisory lock to serialise cycle checks. Dashboard renders one unified tree, built from an unpaginated visible drop feed. Drop mutations keyed by `drop.id`; visibility rules from `listAllVisible` are reused on the server.

**Tech stack:** Node ≥ 22, Fastify, TypeScript (ESM, `@/*` paths), Drizzle ORM, Postgres 16, EJS views, Vitest (unit + integration), Playwright (e2e).

**Conventions to respect (from CLAUDE.md):**
- Every `.ts` file starts with two `// ABOUTME: ` lines.
- British English in user-facing copy.
- Smallest changes, no incidental refactors. Match surrounding style.
- TDD: failing test → minimal code → green → refactor → commit.
- Integration tests need `docker compose up -d` first.

---

## Task 1 — Schema: folders table + drops.folder_id

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0002_<generated>.sql` (via `pnpm db:generate`)

**Step 1: Edit `src/db/schema.ts`.**

Add to the imports (already present: `pgTable, text, uuid, bigint, integer, timestamp, uniqueIndex, index, primaryKey, check`).

Add after the `dropViewers` export:

```ts
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): any => folders.id, { onDelete: 'restrict' }),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  noSelfParent: check('folders_no_self_parent', sql`${t.id} <> ${t.parentId}`),
  siblingUniqueNamed: uniqueIndex('folders_sibling_name_unique')
    .on(t.parentId, t.name).where(sql`${t.parentId} IS NOT NULL`),
  rootUniqueNamed: uniqueIndex('folders_root_name_unique')
    .on(t.name).where(sql`${t.parentId} IS NULL`),
}));
```

Add `folderId` to `drops` (alongside the existing columns):

```ts
  folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
```

Add to the existing `drops` table-config object:

```ts
  folderIdx: index('drops_folder_id_idx').on(t.folderId),
```

**Step 2: Generate the migration.**

Run: `pnpm db:generate`
Expected: a new file appears in `src/db/migrations/` (e.g. `0002_*.sql`). Inspect it.

**Step 3: Inspect the generated SQL.**

Verify the migration:
- creates `folders` with the `CHECK` and both partial unique indexes,
- adds `folder_id` to `drops` with `ON DELETE SET NULL`,
- creates the `drops_folder_id_idx` index.

If anything is off, hand-edit the `.sql` (drizzle-kit can miss partial-index predicates and raw CHECKs). `ON DELETE SET NULL` and the `ON DELETE RESTRICT` on `parent_id` must both be in the SQL.

**Step 4: Run the migration against the dev database.**

Start dockerised Postgres if not already running: `docker compose up -d`
Run: `pnpm db:migrate`
Expected: migration applies without error.

**Step 5: Typecheck.**

Run: `pnpm typecheck`
Expected: no errors.

**Step 6: Commit.**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat(folders): schema — folders table and drops.folder_id"
```

---

## Task 2 — Folder name validator (unit)

**Files:**
- Create: `src/lib/folderName.ts`
- Create: `tests/unit/folderName.test.ts`

**Step 1: Write the failing test.**

`tests/unit/folderName.test.ts`:

```ts
// ABOUTME: Unit tests for folder name validation.
// ABOUTME: Rules: 1–64 NFC chars, trimmed, no control chars, no slashes.
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
    expect(() => cleanFolderName('a\u0000b')).toThrow();
    expect(() => cleanFolderName('a\tb')).toThrow();
    expect(() => cleanFolderName('a\nb')).toThrow();
  });

  it('NFC-normalises composed/decomposed forms', () => {
    const composed = '\u00e9';         // é
    const decomposed = 'e\u0301';       // e + combining acute
    expect(cleanFolderName(decomposed)).toBe(composed);
  });
});
```

**Step 2: Run the test to verify failure.**

Run: `pnpm test -- tests/unit/folderName.test.ts`
Expected: all tests fail with "Cannot find module '@/lib/folderName'" or similar.

**Step 3: Implement `src/lib/folderName.ts`.**

```ts
// ABOUTME: Folder name sanitisation — trims, NFC-normalises, bans control chars and slashes, caps at 64.
// ABOUTME: Throws InvalidFolderName on any violation; no silent mutation beyond trim + NFC.
export class InvalidFolderName extends Error {
  constructor(reason: string) {
    super(`invalid folder name: ${reason}`);
    this.name = 'InvalidFolderName';
  }
}

export function cleanFolderName(raw: string): string {
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed.length === 0) throw new InvalidFolderName('empty');
  if (trimmed.length > 64) throw new InvalidFolderName('too long');
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new InvalidFolderName('control char');
  if (/[\/\\]/.test(trimmed)) throw new InvalidFolderName('slash not allowed');
  return trimmed;
}
```

**Step 4: Run the test to verify pass.**

Run: `pnpm test -- tests/unit/folderName.test.ts`
Expected: all tests pass.

**Step 5: Commit.**

```bash
git add src/lib/folderName.ts tests/unit/folderName.test.ts
git commit -m "feat(folders): cleanFolderName validator"
```

---

## Task 3 — Service module skeleton + sibling-rename helper (unit)

**Files:**
- Create: `src/services/folders.ts`
- Create: `tests/unit/folders-rename-helper.test.ts`

The rename helper is pure and unit-testable in isolation; the rest of the service is exercised in the integration tests in later tasks. Writing it now removes one of the trickier pieces of logic from later tasks.

**Step 1: Write the failing test.**

`tests/unit/folders-rename-helper.test.ts`:

```ts
// ABOUTME: Unit test for the deterministic rename fallback used when reparenting collides with an existing sibling.
// ABOUTME: Rules: "X (from P)" → truncate to 64 → append " (N)" with further base truncation until free.
import { describe, it, expect } from 'vitest';
import { resolveReparentName } from '@/services/folders';

describe('resolveReparentName', () => {
  it('returns base if no collision', () => {
    expect(resolveReparentName('reports', 'deleted', new Set())).toBe('reports');
  });

  it('adds " (from X)" suffix on direct collision', () => {
    expect(resolveReparentName('reports', 'q1', new Set(['reports'])))
      .toBe('reports (from q1)');
  });

  it('appends " (1)", " (2)", ... when the (from X) form also collides', () => {
    const taken = new Set(['reports', 'reports (from q1)']);
    expect(resolveReparentName('reports', 'q1', taken)).toBe('reports (from q1) (1)');
  });

  it('truncates base so the (from X) suffix fits in 64 chars', () => {
    const base = 'a'.repeat(60);
    const parent = 'q1';
    const suffix = ' (from q1)'; // 10 chars
    const result = resolveReparentName(base, parent, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.endsWith(suffix)).toBe(true);
  });

  it('truncates a long parent name inside the suffix with an ellipsis if needed', () => {
    const base = 'x';
    const parent = 'p'.repeat(80);
    const result = resolveReparentName(base, parent, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.startsWith('x (from ')).toBe(true);
    expect(result.endsWith(')')).toBe(true);
  });
});
```

**Step 2: Run the test.**

Run: `pnpm test -- tests/unit/folders-rename-helper.test.ts`
Expected: all tests fail (module missing).

**Step 3: Implement just enough in `src/services/folders.ts`.**

```ts
// ABOUTME: Folder CRUD + tree operations. Structural mutations take a transaction-scoped advisory lock.
// ABOUTME: resolveReparentName is exported for unit testing of the delete-time collision rule.
const REPARENT_ADVISORY_LOCK_KEY = 4137_000_001; // arbitrary constant; documented in the design plan
const MAX_NAME = 64;

export function resolveReparentName(base: string, deletedParentName: string, taken: ReadonlySet<string>): string {
  // Try the base first — no collision case.
  if (!taken.has(base)) return base;

  // Build " (from <parent>)" with ellipsis truncation if it alone would blow the budget.
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
    // Trim the base (left of the suffix) to fit.
    const keep = Math.max(1, MAX_NAME - fromSuffix.length);
    return name.slice(0, keep) + fromSuffix;
  }

  const withFrom = fit(base + fromSuffix);
  if (!taken.has(withFrom)) return withFrom;

  // Append (N) while budget allows.
  for (let n = 1; n < 10_000; n++) {
    const nSuffix = ` (${n})`;
    const cap = MAX_NAME - nSuffix.length;
    const body = withFrom.length > cap ? withFrom.slice(0, cap) : withFrom;
    const candidate = body + nSuffix;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('could not resolve reparent name — too many collisions');
}
```

(File must begin with the two `ABOUTME` lines.)

**Step 4: Run the test.**

Run: `pnpm test -- tests/unit/folders-rename-helper.test.ts`
Expected: all tests pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/unit/folders-rename-helper.test.ts
git commit -m "feat(folders): resolveReparentName helper"
```

---

## Task 4 — Service: createFolder (integration)

**Files:**
- Modify: `src/services/folders.ts`
- Create: `tests/integration/folders.test.ts`

**Step 1: Write the failing test.**

`tests/integration/folders.test.ts`:

```ts
// ABOUTME: Integration tests for folder service. Runs against real Postgres via docker compose.
// ABOUTME: Tests cover create/rename/move/delete-with-reparent + setDropFolder + visibility gating.
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/db';
import { folders, users } from '@/db/schema';
import { createFolder } from '@/services/folders';
import { InvalidFolderName } from '@/lib/folderName';
import { truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/factories';

describe('createFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await truncateAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('creates a root folder', async () => {
    const f = await createFolder(userId, 'reports');
    expect(f.name).toBe('reports');
    expect(f.parentId).toBeNull();
    expect(f.createdBy).toBe(userId);
  });

  it('creates a nested folder', async () => {
    const root = await createFolder(userId, 'reports');
    const child = await createFolder(userId, '2026', root.id);
    expect(child.parentId).toBe(root.id);
  });

  it('rejects invalid names', async () => {
    await expect(createFolder(userId, '')).rejects.toThrow(InvalidFolderName);
    await expect(createFolder(userId, 'a/b')).rejects.toThrow(InvalidFolderName);
  });

  it('rejects sibling-name collision at root', async () => {
    await createFolder(userId, 'reports');
    await expect(createFolder(userId, 'reports')).rejects.toThrow(/name taken/i);
  });

  it('rejects sibling-name collision under same parent', async () => {
    const root = await createFolder(userId, 'reports');
    await createFolder(userId, '2026', root.id);
    await expect(createFolder(userId, '2026', root.id)).rejects.toThrow(/name taken/i);
  });

  it('allows the same name under different parents', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await createFolder(userId, 'same', a.id);
    const sameUnderB = await createFolder(userId, 'same', b.id);
    expect(sameUnderB.parentId).toBe(b.id);
  });

  it('rejects a parentId that does not exist', async () => {
    await expect(createFolder(userId, 'x', '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/parent not found/i);
  });
});
```

Check whether `tests/helpers/db.ts` exposes `truncateAll` and whether `tests/helpers/factories.ts` has `insertUser`. If the names differ, match the existing conventions — read the other integration tests (e.g. `tests/integration/drops.test.ts`) and reuse whatever they import.

**Step 2: Run to confirm failure.**

Run: `docker compose up -d && pnpm test -- tests/integration/folders.test.ts`
Expected: `createFolder is not a function` or module missing.

**Step 3: Implement `createFolder` in `src/services/folders.ts`.**

Add to the imports at the top:

```ts
import { eq, and, sql, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { folders, drops } from '@/db/schema';
import { cleanFolderName, InvalidFolderName } from '@/lib/folderName';
```

Add custom errors near the top of the module (after the ABOUTME lines):

```ts
export class FolderNameTaken extends Error {
  constructor() { super('folder name taken'); this.name = 'FolderNameTaken'; }
}
export class FolderNotFound extends Error {
  constructor() { super('folder not found'); this.name = 'FolderNotFound'; }
}
export class FolderCycle extends Error {
  constructor() { super('folder would create a cycle'); this.name = 'FolderCycle'; }
}
export class FolderParentNotFound extends Error {
  constructor() { super('parent folder not found'); this.name = 'FolderParentNotFound'; }
}
```

Add the function:

```ts
export interface Folder {
  id: string; name: string; parentId: string | null; createdBy: string; createdAt: Date;
}

async function acquireStructuralLock(tx: typeof db) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPARENT_ADVISORY_LOCK_KEY})`);
}

export async function createFolder(userId: string, rawName: string, parentId?: string | null): Promise<Folder> {
  const name = cleanFolderName(rawName); // throws InvalidFolderName
  return db.transaction(async (tx) => {
    await acquireStructuralLock(tx);
    if (parentId != null) {
      const parent = await tx.select().from(folders).where(eq(folders.id, parentId));
      if (parent.length === 0) throw new FolderParentNotFound();
    }
    try {
      const [row] = await tx.insert(folders).values({
        name, parentId: parentId ?? null, createdBy: userId,
      }).returning();
      return {
        id: row.id, name: row.name, parentId: row.parentId,
        createdBy: row.createdBy, createdAt: row.createdAt,
      };
    } catch (e: any) {
      if (e?.code === '23505') throw new FolderNameTaken();
      throw e;
    }
  });
}
```

**Step 4: Run to confirm pass.**

Run: `pnpm test -- tests/integration/folders.test.ts`
Expected: all tests pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders.test.ts
git commit -m "feat(folders): createFolder with advisory lock + uniqueness"
```

---

## Task 5 — Service: renameFolder

**Files:**
- Modify: `src/services/folders.ts`
- Modify: `tests/integration/folders.test.ts`

**Step 1: Append a new `describe` block to the integration test.**

```ts
describe('renameFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await truncateAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('renames a folder', async () => {
    const f = await createFolder(userId, 'reports');
    const renamed = await renameFolder(f.id, 'archive');
    expect(renamed.name).toBe('archive');
  });

  it('rejects invalid names', async () => {
    const f = await createFolder(userId, 'reports');
    await expect(renameFolder(f.id, '')).rejects.toThrow();
    await expect(renameFolder(f.id, 'a/b')).rejects.toThrow();
  });

  it('rejects sibling-name collision', async () => {
    await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await expect(renameFolder(b.id, 'a')).rejects.toThrow(/name taken/i);
  });

  it('allows renaming to the same name (no-op)', async () => {
    const f = await createFolder(userId, 'reports');
    const again = await renameFolder(f.id, 'reports');
    expect(again.name).toBe('reports');
  });

  it('throws FolderNotFound for a missing id', async () => {
    await expect(renameFolder('00000000-0000-0000-0000-000000000000', 'x'))
      .rejects.toThrow(/folder not found/i);
  });
});
```

Add `renameFolder` to the imports from `@/services/folders`.

**Step 2: Run to see failures.**
Run: `pnpm test -- tests/integration/folders.test.ts`
Expected: new tests fail (function missing).

**Step 3: Add `renameFolder` to `src/services/folders.ts`.**

```ts
export async function renameFolder(id: string, rawName: string): Promise<Folder> {
  const name = cleanFolderName(rawName);
  return db.transaction(async (tx) => {
    await acquireStructuralLock(tx);
    const existing = await tx.select().from(folders).where(eq(folders.id, id));
    if (existing.length === 0) throw new FolderNotFound();
    if (existing[0].name === name) {
      return toFolder(existing[0]);
    }
    try {
      const [row] = await tx.update(folders).set({ name }).where(eq(folders.id, id)).returning();
      return toFolder(row);
    } catch (e: any) {
      if (e?.code === '23505') throw new FolderNameTaken();
      throw e;
    }
  });
}

function toFolder(r: typeof folders.$inferSelect): Folder {
  return { id: r.id, name: r.name, parentId: r.parentId, createdBy: r.createdBy, createdAt: r.createdAt };
}
```

Refactor `createFolder` to use `toFolder`.

**Step 4: Run to confirm pass.**
Run: `pnpm test -- tests/integration/folders.test.ts`
Expected: all pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders.test.ts
git commit -m "feat(folders): renameFolder"
```

---

## Task 6 — Service: moveFolder with cycle guard

**Files:**
- Modify: `src/services/folders.ts`
- Modify: `tests/integration/folders.test.ts`

**Step 1: Add a failing test block.**

```ts
describe('moveFolder', () => {
  let userId: string;
  beforeEach(async () => {
    await truncateAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('moves a folder to a new parent', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    const moved = await moveFolder(b.id, a.id);
    expect(moved.parentId).toBe(a.id);
  });

  it('moves a folder to root', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b', a.id);
    const moved = await moveFolder(b.id, null);
    expect(moved.parentId).toBeNull();
  });

  it('rejects moving a folder into itself', async () => {
    const a = await createFolder(userId, 'a');
    await expect(moveFolder(a.id, a.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects moving a folder into its own descendant', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b', a.id);
    const c = await createFolder(userId, 'c', b.id);
    await expect(moveFolder(a.id, c.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects sibling-name collision at the new parent', async () => {
    const a = await createFolder(userId, 'a');
    const b = await createFolder(userId, 'b');
    await createFolder(userId, 'dup', a.id);
    const dupAtRoot = await createFolder(userId, 'dup', b.id);
    await expect(moveFolder(dupAtRoot.id, a.id)).rejects.toThrow(/name taken/i);
  });
});
```

**Step 2: Run to confirm failure.**

**Step 3: Implement.**

```ts
async function isDescendantOf(tx: any, candidateAncestor: string, start: string | null): Promise<boolean> {
  let cur = start;
  const seen = new Set<string>();
  while (cur) {
    if (cur === candidateAncestor) return true;
    if (seen.has(cur)) return false; // defence against a pre-existing cycle (shouldn't exist)
    seen.add(cur);
    const rows = await tx.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, cur));
    if (rows.length === 0) return false;
    cur = rows[0].parentId;
  }
  return false;
}

export async function moveFolder(id: string, newParentId: string | null): Promise<Folder> {
  return db.transaction(async (tx) => {
    await acquireStructuralLock(tx);
    const existing = await tx.select().from(folders).where(eq(folders.id, id));
    if (existing.length === 0) throw new FolderNotFound();
    if (newParentId === id) throw new FolderCycle();
    if (newParentId != null) {
      const parent = await tx.select().from(folders).where(eq(folders.id, newParentId));
      if (parent.length === 0) throw new FolderParentNotFound();
      if (await isDescendantOf(tx, id, newParentId)) throw new FolderCycle();
    }
    try {
      const [row] = await tx.update(folders).set({ parentId: newParentId }).where(eq(folders.id, id)).returning();
      return toFolder(row);
    } catch (e: any) {
      if (e?.code === '23505') throw new FolderNameTaken();
      throw e;
    }
  });
}
```

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders.test.ts
git commit -m "feat(folders): moveFolder with cycle guard"
```

---

## Task 7 — Service: deleteFolderReparenting (including collision rename)

**Files:**
- Modify: `src/services/folders.ts`
- Modify: `tests/integration/folders.test.ts`

**Step 1: Add failing tests.**

```ts
describe('deleteFolderReparenting', () => {
  let userId: string;
  beforeEach(async () => {
    await truncateAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
  });

  it('deletes an empty folder', async () => {
    const f = await createFolder(userId, 'x');
    await deleteFolderReparenting(f.id);
    const after = await db.select().from(folders).where(eq(folders.id, f.id));
    expect(after).toHaveLength(0);
  });

  it('reparents child folders and drops up one level', async () => {
    const parent = await createFolder(userId, 'parent');
    const mid = await createFolder(userId, 'mid', parent.id);
    const child = await createFolder(userId, 'child', mid.id);
    const drop = await insertDrop({ ownerId: userId, name: 'd1', folderId: mid.id });
    await deleteFolderReparenting(mid.id);

    const [childAfter] = await db.select().from(folders).where(eq(folders.id, child.id));
    expect(childAfter.parentId).toBe(parent.id);
    const [dropAfter] = await db.select().from(drops).where(eq(drops.id, drop.id));
    expect(dropAfter.folderId).toBe(parent.id);
  });

  it('reparents to root when the deleted folder had no parent', async () => {
    const top = await createFolder(userId, 'top');
    const child = await createFolder(userId, 'child', top.id);
    await deleteFolderReparenting(top.id);
    const [childAfter] = await db.select().from(folders).where(eq(folders.id, child.id));
    expect(childAfter.parentId).toBeNull();
  });

  it('renames a child folder on sibling-name collision during reparent', async () => {
    const parent = await createFolder(userId, 'parent');
    await createFolder(userId, 'dup', parent.id);             // already exists under parent
    const mid = await createFolder(userId, 'mid', parent.id);
    await createFolder(userId, 'dup', mid.id);                // will collide on reparent

    await deleteFolderReparenting(mid.id);

    const under = await db.select().from(folders).where(eq(folders.parentId, parent.id));
    const names = under.map((r) => r.name).sort();
    expect(names).toContain('dup');
    expect(names).toContain('dup (from mid)');
  });

  it('throws FolderNotFound for a missing id', async () => {
    await expect(deleteFolderReparenting('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/folder not found/i);
  });
});
```

`insertDrop` helper: look in `tests/helpers/factories.ts`. If none exists, add one that inserts a row directly into `drops` and returns `{ id }` — keep it minimal.

**Step 2: Run to confirm failure.**

**Step 3: Implement.**

```ts
export async function deleteFolderReparenting(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await acquireStructuralLock(tx);
    const existing = await tx.select().from(folders).where(eq(folders.id, id));
    if (existing.length === 0) throw new FolderNotFound();
    const toDelete = existing[0];
    const newParentId = toDelete.parentId;

    // Collect names already present under the new parent (excluding the folder being deleted).
    const siblingRows = newParentId == null
      ? await tx.select({ name: folders.name }).from(folders).where(isNull(folders.parentId))
      : await tx.select({ name: folders.name }).from(folders).where(eq(folders.parentId, newParentId));
    const taken = new Set(siblingRows.map((r) => r.name).filter((n) => n !== toDelete.name));
    // The deleted folder's own name is about to disappear, so its slot is free.

    // Reparent child folders, renaming on collision.
    const children = await tx.select().from(folders).where(eq(folders.parentId, id));
    for (const c of children) {
      const finalName = resolveReparentName(c.name, toDelete.name, taken);
      taken.add(finalName);
      await tx.update(folders).set({ parentId: newParentId, name: finalName }).where(eq(folders.id, c.id));
    }

    // Reparent drops. Drop names are URL-bound — never renamed. Folders don't participate in drop name uniqueness.
    await tx.update(drops).set({ folderId: newParentId }).where(eq(drops.folderId, id));

    // Delete the folder.
    await tx.delete(folders).where(eq(folders.id, id));
  });
}
```

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders.test.ts
git commit -m "feat(folders): deleteFolderReparenting with collision rename"
```

---

## Task 8 — Service: setDropFolder (visibility-gated)

**Files:**
- Modify: `src/services/folders.ts`
- Modify: `tests/integration/folders.test.ts`

**Step 1: Add failing tests.**

```ts
describe('setDropFolder', () => {
  let ownerId: string;
  let otherMemberId: string;
  beforeEach(async () => {
    await truncateAll();
    const owner = await insertUser({ email: 'o@x.test', username: 'owner' });
    const other = await insertUser({ email: 'm@x.test', username: 'member' });
    ownerId = owner.id; otherMemberId = other.id;
  });

  it('files a drop into a folder', async () => {
    const f = await createFolder(ownerId, 'box');
    const d = await insertDrop({ ownerId, name: 'mine' });
    await setDropFolder({ id: ownerId, email: 'o@x.test' }, d.id, f.id);
    const [after] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(after.folderId).toBe(f.id);
  });

  it('unfiles when folderId is null', async () => {
    const f = await createFolder(ownerId, 'box');
    const d = await insertDrop({ ownerId, name: 'mine', folderId: f.id });
    await setDropFolder({ id: ownerId, email: 'o@x.test' }, d.id, null);
    const [after] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(after.folderId).toBeNull();
  });

  it('other members can file public/authed drops of another owner', async () => {
    const f = await createFolder(otherMemberId, 'box');
    const d = await insertDrop({ ownerId, name: 'open', viewMode: 'authed' });
    await setDropFolder({ id: otherMemberId, email: 'm@x.test' }, d.id, f.id);
    const [after] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(after.folderId).toBe(f.id);
  });

  it('rejects filing an emails-mode drop the actor is not listed on', async () => {
    const f = await createFolder(otherMemberId, 'box');
    const d = await insertDrop({ ownerId, name: 'locked', viewMode: 'emails' });
    await expect(setDropFolder({ id: otherMemberId, email: 'm@x.test' }, d.id, f.id))
      .rejects.toThrow(/not visible/i);
  });

  it('allows filing an emails-mode drop the actor IS listed on', async () => {
    const f = await createFolder(otherMemberId, 'box');
    const d = await insertDrop({ ownerId, name: 'shared', viewMode: 'emails' });
    await db.insert(dropViewers).values({ dropId: d.id, email: 'm@x.test' });
    await setDropFolder({ id: otherMemberId, email: 'm@x.test' }, d.id, f.id);
    const [after] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(after.folderId).toBe(f.id);
  });

  it('rejects a folderId that does not exist', async () => {
    const d = await insertDrop({ ownerId, name: 'x' });
    await expect(setDropFolder({ id: ownerId, email: 'o@x.test' }, d.id, '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/folder not found/i);
  });
});
```

Import `dropViewers` from `@/db/schema` in the test file.

**Step 2: Run to confirm failure.**

**Step 3: Implement `setDropFolder`.**

```ts
import { normaliseEmail } from '@/lib/email';
import { dropViewers } from '@/db/schema';

export class DropNotVisible extends Error {
  constructor() { super('drop not visible to actor'); this.name = 'DropNotVisible'; }
}
export class DropNotFound extends Error {
  constructor() { super('drop not found'); this.name = 'DropNotFound'; }
}

async function canUserSeeDrop(tx: any, user: { id: string; email: string }, dropId: string): Promise<boolean> {
  const rows = await tx.select({ ownerId: drops.ownerId, viewMode: drops.viewMode })
    .from(drops).where(eq(drops.id, dropId));
  if (rows.length === 0) return false;
  const row = rows[0];
  if (row.ownerId === user.id) return true;
  if (row.viewMode === 'public' || row.viewMode === 'authed') return true;
  if (row.viewMode === 'emails') {
    const normEmail = normaliseEmail(user.email);
    const v = await tx.select().from(dropViewers)
      .where(and(eq(dropViewers.dropId, dropId), eq(dropViewers.email, normEmail)));
    return v.length > 0;
  }
  return false;
}

export async function setDropFolder(
  user: { id: string; email: string },
  dropId: string,
  folderId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    // No structural lock needed — we're not mutating the folder tree.
    const dropRows = await tx.select({ id: drops.id }).from(drops).where(eq(drops.id, dropId));
    if (dropRows.length === 0) throw new DropNotFound();
    const visible = await canUserSeeDrop(tx, user, dropId);
    if (!visible) throw new DropNotVisible();
    if (folderId != null) {
      const f = await tx.select().from(folders).where(eq(folders.id, folderId));
      if (f.length === 0) throw new FolderNotFound();
    }
    await tx.update(drops).set({ folderId }).where(eq(drops.id, dropId));
  });
}
```

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders.test.ts
git commit -m "feat(folders): setDropFolder with visibility gate"
```

---

## Task 9 — Unpaginated visible-drops feed + folder listing

**Files:**
- Modify: `src/services/drops.ts`
- Modify: `src/services/folders.ts`
- Create: `tests/integration/folders-tree.test.ts`

The dashboard tree needs all visible drops, not the current 25-row page. And it needs to load every folder with a per-viewer count.

**Step 1: Write the failing test.**

`tests/integration/folders-tree.test.ts`:

```ts
// ABOUTME: Integration tests for the per-viewer folder tree builder used by the dashboard.
// ABOUTME: Counts reflect only drops visible to the viewer (emails-mode drops hidden from non-listed members).
import { describe, it, expect, beforeEach } from 'vitest';
import { truncateAll } from '../helpers/db';
import { insertUser, insertDrop } from '../helpers/factories';
import { createFolder, listFolderTree } from '@/services/folders';
import { db } from '@/db';
import { drops, dropViewers } from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('listFolderTree', () => {
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };
  beforeEach(async () => {
    await truncateAll();
    const a = await insertUser({ email: 'alice@x.test', username: 'alice' });
    const b = await insertUser({ email: 'bob@x.test', username: 'bob' });
    alice = { id: a.id, email: 'alice@x.test' };
    bob = { id: b.id, email: 'bob@x.test' };
  });

  it('returns the full folder list with visible counts', async () => {
    const fa = await createFolder(alice.id, 'work');
    await createFolder(alice.id, 'sub', fa.id);
    const d = await insertDrop({ ownerId: alice.id, name: 'pub', viewMode: 'public', folderId: fa.id });

    const tree = await listFolderTree(alice);
    expect(tree.folders.length).toBe(2);
    const workNode = tree.folders.find((f) => f.id === fa.id)!;
    expect(workNode.drops.map((x) => x.id)).toContain(d.id);
  });

  it('omits drops the viewer cannot see', async () => {
    const f = await createFolder(alice.id, 'secret');
    const d = await insertDrop({ ownerId: alice.id, name: 'hidden', viewMode: 'emails', folderId: f.id });

    const asAlice = await listFolderTree(alice);
    const asBob = await listFolderTree(bob);
    expect(asAlice.folders.find((x) => x.id === f.id)!.drops.map((x) => x.id)).toContain(d.id);
    expect(asBob.folders.find((x) => x.id === f.id)!.drops.map((x) => x.id)).not.toContain(d.id);
  });

  it('includes the drop when the viewer is on the emails list', async () => {
    const f = await createFolder(alice.id, 'shared');
    const d = await insertDrop({ ownerId: alice.id, name: 'shared', viewMode: 'emails', folderId: f.id });
    await db.insert(dropViewers).values({ dropId: d.id, email: 'bob@x.test' });

    const asBob = await listFolderTree(bob);
    expect(asBob.folders.find((x) => x.id === f.id)!.drops.map((x) => x.id)).toContain(d.id);
  });

  it('returns unfoldered drops as rootDrops', async () => {
    const d = await insertDrop({ ownerId: alice.id, name: 'floating', viewMode: 'public' });
    const tree = await listFolderTree(alice);
    expect(tree.rootDrops.map((x) => x.id)).toContain(d.id);
  });

  it('with mineOnly=true, drops are restricted to the caller owner but folders stay', async () => {
    const f = await createFolder(bob.id, 'bobs-work');
    await insertDrop({ ownerId: bob.id, name: 'bob-drop', viewMode: 'public', folderId: f.id });
    await insertDrop({ ownerId: alice.id, name: 'alice-drop', viewMode: 'public' });

    const tree = await listFolderTree(alice, { mineOnly: true });
    expect(tree.folders.map((x) => x.id)).toContain(f.id);                  // folder present
    expect(tree.folders.find((x) => x.id === f.id)!.drops.length).toBe(0);  // no drops visible in mine-only
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['alice-drop']);
  });
});
```

**Step 2: Run to confirm failure.**

**Step 3: Implement `listFolderTree` in `src/services/folders.ts`.**

Use a single raw SQL query that mirrors the `listAllVisible` WHERE clause, with no `LIMIT`/`OFFSET`. Join users for owner username. Do the grouping in TypeScript.

```ts
import type { DropListItem } from '@/services/drops';

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  drops: DropListItem[];
}

export interface FolderTree {
  folders: FolderNode[];   // all folders; render client picks roots/children via parentId
  rootDrops: DropListItem[];
}

export async function listFolderTree(
  user: { id: string; email: string },
  opts: { mineOnly?: boolean } = {},
): Promise<FolderTree> {
  const normEmail = normaliseEmail(user.email);
  const allFolders = await db.select().from(folders).orderBy(folders.name);

  // Visible drops — either restricted to caller (mineOnly) or to the full visibility set.
  const rows = await db.execute<{
    d_id: string; owner_id: string; name: string; view_mode: string;
    current_version: string | null; created_at: Date; updated_at: Date;
    v_id: string | null; r2_prefix: string | null; byte_size: number | null;
    file_count: number | null; v_created_at: Date | null;
    username: string | null; folder_id: string | null;
  }>(opts.mineOnly
    ? sql`SELECT d.id AS d_id, d.owner_id, d.name, d.view_mode, d.current_version,
                 d.created_at, d.updated_at, d.folder_id,
                 v.id AS v_id, v.r2_prefix, v.byte_size, v.file_count, v.created_at AS v_created_at,
                 u.username
          FROM drops d
          INNER JOIN users u ON u.id = d.owner_id
          LEFT JOIN drop_versions v ON v.id = d.current_version
          WHERE d.owner_id = ${user.id}
          ORDER BY d.updated_at DESC`
    : sql`SELECT d.id AS d_id, d.owner_id, d.name, d.view_mode, d.current_version,
                 d.created_at, d.updated_at, d.folder_id,
                 v.id AS v_id, v.r2_prefix, v.byte_size, v.file_count, v.created_at AS v_created_at,
                 u.username
          FROM drops d
          INNER JOIN users u ON u.id = d.owner_id
          LEFT JOIN drop_versions v ON v.id = d.current_version
          WHERE d.owner_id = ${user.id}
             OR d.view_mode = 'public'
             OR d.view_mode = 'authed'
             OR (d.view_mode = 'emails' AND EXISTS (
                   SELECT 1 FROM drop_viewers dv WHERE dv.drop_id = d.id AND dv.email = ${normEmail}))
          ORDER BY d.updated_at DESC`);

  const dropsByFolder = new Map<string | null, DropListItem[]>();
  for (const row of rows) {
    const item: DropListItem = {
      id: row.d_id, name: row.name, ownerId: row.owner_id,
      viewMode: row.view_mode as any, currentVersion: row.current_version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      version: row.v_id ? {
        id: row.v_id, r2Prefix: row.r2_prefix!, byteSize: Number(row.byte_size!),
        fileCount: row.file_count!, createdAt: row.v_created_at!,
      } : null,
      ownerUsername: row.username,
    };
    const key = row.folder_id;
    const list = dropsByFolder.get(key) ?? [];
    list.push(item);
    dropsByFolder.set(key, list);
  }

  const folderNodes: FolderNode[] = allFolders.map((f) => ({
    id: f.id, name: f.name, parentId: f.parentId,
    drops: dropsByFolder.get(f.id) ?? [],
  }));

  return {
    folders: folderNodes,
    rootDrops: dropsByFolder.get(null) ?? [],
  };
}
```

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/services/folders.ts tests/integration/folders-tree.test.ts
git commit -m "feat(folders): listFolderTree with per-viewer visibility"
```

---

## Task 10 — Route: POST /app/folders (create)

**Files:**
- Create: `src/routes/app/folders.ts`
- Modify: `src/index.ts`
- Create: `tests/integration/folders-routes.test.ts`

**Step 1: Write failing tests.**

`tests/integration/folders-routes.test.ts`:

```ts
// ABOUTME: Integration tests for folder HTTP routes on the app origin.
// ABOUTME: All mutations are POST + CSRF-protected; 303 on success, 400 on validation.
import { describe, it, expect, beforeEach } from 'vitest';
import { startTestServer, signedAppCookie } from '../helpers/server';
import { truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/factories';
import { db } from '@/db';
import { folders } from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('POST /app/folders', () => {
  let app: Awaited<ReturnType<typeof startTestServer>>;
  let userId: string; let session: { cookies: string; csrf: string };

  beforeEach(async () => {
    await truncateAll();
    const u = await insertUser({ email: 'a@x.test', username: 'alice' });
    userId = u.id;
    app = await startTestServer();
    session = await signedAppCookie(app, userId);
  });

  it('creates a root folder and 303s to dashboard', async () => {
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=reports&_csrf=${session.csrf}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/app/);
    const rows = await db.select().from(folders).where(eq(folders.name, 'reports'));
    expect(rows.length).toBe(1);
  });

  it('rejects requests without a CSRF token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=reports`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('400s on invalid name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=a%2Fb&_csrf=${session.csrf}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on duplicate sibling name', async () => {
    await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=reports&_csrf=${session.csrf}`,
    });
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=reports&_csrf=${session.csrf}`,
    });
    expect(res.statusCode).toBe(400);
  });
});
```

Inspect existing integration tests (e.g. `tests/integration/new-drop-form.test.ts`) for the real helper names and origin header — adjust if needed.

**Step 2: Run to confirm failure.**

**Step 3: Implement the route.**

`src/routes/app/folders.ts`:

```ts
// ABOUTME: Folder HTTP routes on the app origin — create, rename, move, delete.
// ABOUTME: All POSTs are CSRF-protected; 303 on success, 400 with an inline dashboard banner on validation errors.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import {
  createFolder, renameFolder, moveFolder, deleteFolderReparenting,
  FolderNameTaken, FolderNotFound, FolderCycle, FolderParentNotFound,
} from '@/services/folders';
import { InvalidFolderName } from '@/lib/folderName';

export const folderRoutes: FastifyPluginAsync = async (app) => {
  app.post('/app/folders', { preHandler: requireCompletedMember }, async (req, reply) => {
    const user = req.user!;
    const body = req.body as { name?: string; parentId?: string };
    try {
      const parentId = body.parentId && body.parentId.length > 0 ? body.parentId : null;
      await createFolder(user.id, body.name ?? '', parentId);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof InvalidFolderName || e instanceof FolderNameTaken || e instanceof FolderParentNotFound) {
        return reply.code(400).send(e.message);
      }
      throw e;
    }
  });
};
```

Wire it in `src/index.ts`:

```ts
import { folderRoutes } from './routes/app/folders';
// inside the app-host registrations, after setPermissionsRoute:
await s.register(folderRoutes);
```

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/routes/app/folders.ts src/index.ts tests/integration/folders-routes.test.ts
git commit -m "feat(folders): POST /app/folders"
```

---

## Task 11 — Route: POST /app/folders/:id/rename

**Files:**
- Modify: `src/routes/app/folders.ts`
- Modify: `tests/integration/folders-routes.test.ts`

**Step 1: Add failing tests for rename.** Cover success, 400 on invalid name, 400 on collision, 404 on missing, 403 on missing CSRF.

**Step 2: Run.**

**Step 3: Add the handler.**

```ts
app.post('/app/folders/:id/rename', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { name?: string };
  try {
    await renameFolder(id, body.name ?? '');
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof InvalidFolderName || e instanceof FolderNameTaken) return reply.code(400).send(e.message);
    if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
    throw e;
  }
});
```

**Step 4: Run.** **Step 5: Commit.**

```bash
git commit -am "feat(folders): POST /app/folders/:id/rename"
```

---

## Task 12 — Route: POST /app/folders/:id/move

Same shape as Task 11. Tests cover: move to root (empty `parentId`), move under a parent, 400 on cycle, 400 on collision, 404 on missing.

Handler:

```ts
app.post('/app/folders/:id/move', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { parentId?: string };
  const parentId = body.parentId && body.parentId.length > 0 ? body.parentId : null;
  try {
    await moveFolder(id, parentId);
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof FolderCycle || e instanceof FolderNameTaken || e instanceof FolderParentNotFound) {
      return reply.code(400).send(e.message);
    }
    if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
    throw e;
  }
});
```

Commit: `git commit -am "feat(folders): POST /app/folders/:id/move"`

---

## Task 13 — Route: POST /app/folders/:id/delete

Tests: success (empty), success with reparent, 404 on missing.

Handler:

```ts
app.post('/app/folders/:id/delete', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await deleteFolderReparenting(id);
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
    throw e;
  }
});
```

Commit: `git commit -am "feat(folders): POST /app/folders/:id/delete"`

---

## Task 14 — Route: POST /app/drops/:id/folder

**Files:**
- Modify: `src/routes/app/folders.ts` (or a new file if preferred — the domain is "filing a drop", which fits here)
- Create/modify: `tests/integration/folders-routes.test.ts` (append `describe('POST /app/drops/:id/folder', ...)`)

Tests cover: file a drop I own, unfile (folderId empty), file someone else's `public` drop (succeeds), file someone else's `emails` drop I'm not on (403 or 404 — pick one and stick with it; I'd pick 404 to avoid leaking the drop's existence), 403 on missing CSRF.

Handler:

```ts
import { setDropFolder, DropNotVisible, DropNotFound } from '@/services/folders';

app.post('/app/drops/:id/folder', { preHandler: requireCompletedMember }, async (req, reply) => {
  const user = req.user!;
  const { id } = req.params as { id: string };
  const body = req.body as { folderId?: string };
  const folderId = body.folderId && body.folderId.length > 0 ? body.folderId : null;
  try {
    await setDropFolder({ id: user.id, email: user.email }, id, folderId);
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof DropNotFound || e instanceof DropNotVisible) return reply.code(404).send('not_found');
    if (e instanceof FolderNotFound) return reply.code(400).send('folder_not_found');
    throw e;
  }
});
```

Commit: `git commit -am "feat(folders): POST /app/drops/:id/folder"`

---

## Task 15 — Dashboard: tree + ?mine=1

**Files:**
- Modify: `src/routes/app/dashboard.ts`
- Modify: `tests/integration/dashboard.test.ts` (or create `tests/integration/dashboard-folders.test.ts`)

**Step 1: Write a failing test** that GETs `/app` after seeding a folder and a drop; asserts the HTML contains the folder name and the drop name, that `?mine=1` excludes another owner's drop, and that folder badge counts reflect per-viewer visibility.

**Step 2: Run to confirm failure.**

**Step 3: Update the route.**

```ts
import { listFolderTree } from '@/services/folders';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireCompletedMember }, async (req, reply) => {
    const user = req.user!;
    const mineOnly = (req.query as { mine?: string }).mine === '1';
    const tree = await listFolderTree({ id: user.id, email: user.email }, { mineOnly });
    return reply.view('dashboard.ejs', {
      user,
      tree,
      mineOnly,
      csrfToken: req.csrfToken ?? '',
      formatBytes,
      dropOriginFor,
    });
  });
};
```

**Step 4 & 5:** the dashboard view (Task 16) consumes `tree` + `mineOnly` — tests will stay red until the view lands. Skip to Task 16 before running the dashboard tests.

Commit once Task 16 green: grouped in Task 16's commit.

---

## Task 16 — Dashboard view: unified tree

**Files:**
- Modify: `src/views/dashboard.ejs`
- Create: `src/views/_folderNode.ejs`
- Modify: `src/views/static/style.css`

**Step 1:** Write a failing Playwright test in `tests/e2e/folders.spec.ts`:

```ts
// ABOUTME: E2E smoke for the folder UI: create folder, file a drop, toggle mine-only, delete non-empty folder.
// ABOUTME: Runs against the dev server wired up by the playwright config.
import { test, expect } from '@playwright/test';

test('folder create + file + delete round trip', async ({ page }) => {
  // TODO: reuse the existing e2e auth fixture to log in as a seeded member
  // ... (copy from drop.spec.ts)
  await page.goto('/app');
  await page.getByRole('button', { name: /new folder/i }).click();
  await page.getByLabel(/name/i).fill('reports');
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page.getByText('reports')).toBeVisible();
  // ... file an existing drop into the folder via the move popover
  // ... assert the drop now renders under the folder
  // ... delete the folder via the confirm modal
  // ... assert the drop is back at root
});
```

Seed helpers may need a small extension to create a pre-existing drop for the fixture user.

**Step 2:** Run `pnpm test:e2e` — expect failure.

**Step 3:** Implement the view.

- Render a `New folder` button alongside `New drop` in the page head.
- Render a `Mine only` checkbox that GETs `/app?mine=1` (or `/app`) on change. Plain `<form method=get>` — no JS state.
- Render the tree with a recursive partial `_folderNode.ejs` that emits: a folder row (name, visible-count badge, action icons) plus its children (subfolders first, then drops).
- Render `tree.rootFolders` (folders where `parentId === null`) at the top level, then `tree.rootDrops`.
- Drop rows always show an owner pill (even for own drops — consistent). Suppress `Edit` for drops where `d.ownerId !== user.id`.
- Add a `<dialog>` (or visually styled modal) for the delete confirmation; populate copy with folder name, counts, and destination from data attributes on the trigger.
- Add a move popover that lists every folder as an indented path plus `— root —`. Populate client-side from a `window.__folders` JSON blob the view inlines from `tree.folders`.

Server-side helper: precompute `rootFolders`, and for each folder a sorted list of direct child folder IDs. Shortest route is to pass the whole `tree.folders` to the view and let the partial filter `parentId`-by-`parentId` as it recurses.

**Step 4:** Run the dashboard integration test (Task 15) and the Playwright test. Both should pass.

**Step 5: Commit.**

```bash
git add src/routes/app/dashboard.ts src/views/dashboard.ejs src/views/_folderNode.ejs src/views/static/style.css tests/integration/dashboard-folders.test.ts tests/e2e/folders.spec.ts
git commit -m "feat(folders): dashboard tree, mine-only toggle, move/delete UX"
```

---

## Task 17 — Sweep: verify full suite + typecheck + lint

**Step 1:** Run the full suite.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
```

All four must be green.

**Step 2:** Look for CLAUDE.md violations:
- Every new `.ts` file starts with two `// ABOUTME: ` lines.
- No unrelated edits to files outside the scope.
- User-facing copy (banners, dialog text) in British English.

**Step 3:** Read the full diff (`git log --oneline main..HEAD` and `git diff main...HEAD`). Sanity-check for leftover TODOs, console.logs, or unreferenced code.

**Step 4: Commit** any small fixes found above as a single follow-up commit; otherwise skip. No commit needed for a clean diff.

---

## Notes to the implementer

- The transaction-scoped advisory lock (`pg_advisory_xact_lock`) is intentional — do not move to a row lock or skip it. See the design plan's "Concurrency" section.
- Don't add error handling for scenarios that can't happen. `setDropFolder` doesn't need to handle a missing `folderId` concurrently deleted between the check and the UPDATE — the `ON DELETE SET NULL` on `drops.folder_id` cleans that up, and the worst case is the drop lands at root.
- The design plan is the source of truth for decisions. If a test reveals a contradiction with the design, stop and flag it rather than quietly deviating.
- Helper names (`truncateAll`, `insertUser`, `insertDrop`, `startTestServer`, `signedAppCookie`) are guesses based on the existing test tree — read the current helpers before writing new ones and match their signatures.
