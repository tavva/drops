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

**Test-setup pattern in this repo.** There is no `truncateAll` / `insertUser` / `insertDrop` / `startTestServer` / `signedAppCookie` helper library. The canonical integration-test pattern is inline: see `tests/integration/dashboard.test.ts:1-30` — `beforeAll` calls `buildServer()` and registers the routes under test; `beforeEach` does direct `db.delete(...)` + `db.insert(...)` for the tables it touches; a local `authedCookie()` function inside the file mints a signed session cookie via `createSession` + `signCookie`. The test snippets in this plan use placeholder helper names (`truncateAll`, `insertUser`, `insertDrop`, `signedAppCookie`) for brevity — when implementing, replace them with the inline pattern from `dashboard.test.ts`. Do not invent new helper modules unless a piece of setup is reused across ≥ 3 test files.

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
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
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
- `folders.created_by` is nullable with `ON DELETE SET NULL` (attribution only; folder survives the creator's removal),
- `folders.parent_id` is `ON DELETE RESTRICT` (we always go through the reparenting service),
- adds `folder_id` to `drops` with `ON DELETE SET NULL`,
- creates the `drops_folder_id_idx` index.

If anything is off, hand-edit the `.sql` (drizzle-kit can miss partial-index predicates and raw CHECKs). All three FK actions above must be in the SQL.

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
    expect(f.createdBy).toBe(userId); // still the caller id on create; only goes null if the user row is later deleted
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
  id: string; name: string; parentId: string | null; createdBy: string | null; createdAt: Date;
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

## Task 9 — Shared unpaginated visibility feed (service helper)

**Files:**
- Modify: `src/services/drops.ts`
- Modify: `tests/integration/drops.test.ts` (append a describe block)

The dashboard tree needs the full set of drops a viewer can see, not today's 25-row page. Extract the visibility SQL used by `listAllVisible` into a private helper and expose a new `listAllVisibleUnpaged` that returns every visible drop. `listAllVisible` keeps its signature and becomes a thin wrapper that adds `LIMIT/OFFSET`. Task 10 (folder tree) consumes this helper — no duplicated visibility SQL in the folders module.

**Step 1: Write a failing test** that asserts `listAllVisibleUnpaged` returns every visible drop for a seeded user (own drops, `public`, `authed`, and `emails` drops the user is listed on) and excludes `emails` drops they aren't listed on. Seed > 25 drops to prove it isn't secretly paged.

**Step 2: Run to confirm failure.**

**Step 3: Implement.** Factor the WHERE clause of `listAllVisible` into a private `visibilityWhereClause(userId, normEmail)` returning an `sql` fragment (or keep the body inline and duplicate once — both acceptable). Add:

```ts
export async function listAllVisibleUnpaged(user: { id: string; email: string }): Promise<DropListItem[]> {
  // same SELECT and WHERE as listAllVisible, without LIMIT/OFFSET, with ORDER BY d.name ASC
  // (alphabetical is the order the dashboard wants; callers needing recency can re-sort)
}
```

Key decision: order by `d.name ASC` at the DB level. The dashboard's alphabetical-per-level rule means sorting client-side would still work, but doing it in SQL keeps the order deterministic for tests.

**Step 4: Run tests.** Expected: pass.

**Step 5: Commit.**

```bash
git add src/services/drops.ts tests/integration/drops.test.ts
git commit -m "feat(drops): listAllVisibleUnpaged helper"
```

---

## Task 10 — Service: listFolderTree (view model)

**Files:**
- Modify: `src/services/folders.ts`
- Create: `tests/integration/folders-tree.test.ts`

The view model is the single source of truth for the dashboard. It's computed once per request and consumed by the EJS partials without further tree walking.

**View model shape.** Every consumer uses these exact fields:

```ts
export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  childFolderIds: string[];   // direct children, alphabetical
  drops: DropListItem[];      // direct drops visible to the viewer, alphabetical by name
  visibleDropCount: number;   // drops.length — precomputed so views don't recount
}

export interface FolderTree {
  byId: Map<string, FolderNode>;
  rootFolderIds: string[];    // alphabetical
  rootDrops: DropListItem[];  // alphabetical
}
```

The delete confirmation dialog uses each node's `visibleDropCount` and `childFolderIds.length` — the design's "N drops and M subfolders will move up" copy refers to *direct* children of the deleted folder, not the whole subtree. `childFolderIds` lets the EJS partial recurse without re-filtering on every node.

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

  it('lists all folders under byId and direct-child ids alphabetically', async () => {
    const work = await createFolder(alice.id, 'work');
    const z = await createFolder(alice.id, 'z-sub', work.id);
    const a = await createFolder(alice.id, 'a-sub', work.id);
    const tree = await listFolderTree(alice);
    expect(tree.byId.size).toBe(3);
    expect(tree.byId.get(work.id)!.childFolderIds).toEqual([a.id, z.id]);
  });

  it('places drops inside their folder, sorted alphabetically', async () => {
    const fa = await createFolder(alice.id, 'work');
    const pub = await insertDrop({ ownerId: alice.id, name: 'zed', viewMode: 'public', folderId: fa.id });
    const early = await insertDrop({ ownerId: alice.id, name: 'alpha', viewMode: 'public', folderId: fa.id });
    const tree = await listFolderTree(alice);
    expect(tree.byId.get(fa.id)!.drops.map((x) => x.id)).toEqual([early.id, pub.id]);
  });

  it('omits drops the viewer cannot see; counts reflect per-viewer totals', async () => {
    const f = await createFolder(alice.id, 'secret');
    const d = await insertDrop({ ownerId: alice.id, name: 'hidden', viewMode: 'emails', folderId: f.id });

    const asAlice = await listFolderTree(alice);
    const asBob = await listFolderTree(bob);
    expect(asAlice.byId.get(f.id)!.visibleDropCount).toBe(1);
    expect(asBob.byId.get(f.id)!.visibleDropCount).toBe(0);
    expect(asBob.byId.get(f.id)!.drops.map((x) => x.id)).not.toContain(d.id);
  });

  it('includes the drop when the viewer is on the emails list', async () => {
    const f = await createFolder(alice.id, 'shared');
    const d = await insertDrop({ ownerId: alice.id, name: 'shared', viewMode: 'emails', folderId: f.id });
    await db.insert(dropViewers).values({ dropId: d.id, email: 'bob@x.test' });
    const asBob = await listFolderTree(bob);
    expect(asBob.byId.get(f.id)!.drops.map((x) => x.id)).toContain(d.id);
  });

  it('returns unfoldered drops as rootDrops, alphabetical', async () => {
    const z = await insertDrop({ ownerId: alice.id, name: 'zz', viewMode: 'public' });
    const a = await insertDrop({ ownerId: alice.id, name: 'aa', viewMode: 'public' });
    const tree = await listFolderTree(alice);
    expect(tree.rootDrops.map((x) => x.id)).toEqual([a.id, z.id]);
  });

  it('with mineOnly=true, drops restricted to caller; folders still shown', async () => {
    const f = await createFolder(bob.id, 'bobs-work');
    await insertDrop({ ownerId: bob.id, name: 'bob-drop', viewMode: 'public', folderId: f.id });
    await insertDrop({ ownerId: alice.id, name: 'alice-drop', viewMode: 'public' });
    const tree = await listFolderTree(alice, { mineOnly: true });
    expect(tree.byId.has(f.id)).toBe(true);
    expect(tree.byId.get(f.id)!.visibleDropCount).toBe(0);
    expect(tree.rootDrops.map((x) => x.name)).toEqual(['alice-drop']);
  });
});
```

**Step 2: Run to confirm failure.**

**Step 3: Implement `listFolderTree` in `src/services/folders.ts`.**

Approach: use `listAllVisibleUnpaged` (Task 9) to fetch visible drops, then fetch all folders, then build the view model in TypeScript. Key design choices:

- `listAllVisibleUnpaged` already returns drops sorted alphabetically (Task 9). We need to carry each row's `folderId`, so extend `DropListItem` with `folderId: string | null` and the `SELECT` in `listAllVisibleUnpaged` must include it. That's a one-line ripple: update `DropListItem` in `src/services/drops.ts` when implementing Task 9.
- With `mineOnly`, filter the returned drops to `ownerId === user.id` in memory (the visibility SQL is already doing the viewer filter — we just apply the owner filter on top).

```ts
import type { DropListItem } from '@/services/drops';
import { listAllVisibleUnpaged } from '@/services/drops';

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  childFolderIds: string[];
  drops: DropListItem[];
  visibleDropCount: number;
}

export interface FolderTree {
  byId: Map<string, FolderNode>;
  rootFolderIds: string[];
  rootDrops: DropListItem[];
}

export async function listFolderTree(
  user: { id: string; email: string },
  opts: { mineOnly?: boolean } = {},
): Promise<FolderTree> {
  const allFolders = await db.select().from(folders).orderBy(folders.name);
  let visibleDrops = await listAllVisibleUnpaged(user); // alphabetical by name
  if (opts.mineOnly) visibleDrops = visibleDrops.filter((d) => d.ownerId === user.id);

  // Bucket drops by folder id (null = root).
  const dropsByFolder = new Map<string | null, DropListItem[]>();
  for (const d of visibleDrops) {
    const key = d.folderId;
    const list = dropsByFolder.get(key) ?? [];
    list.push(d);
    dropsByFolder.set(key, list);
  }

  // Build nodes without subtree counts first.
  const byId = new Map<string, FolderNode>();
  const childIdsByParent = new Map<string | null, string[]>();
  for (const f of allFolders) {
    const children = childIdsByParent.get(f.parentId) ?? [];
    children.push(f.id);
    childIdsByParent.set(f.parentId, children);
  }
  for (const f of allFolders) {
    const drops = dropsByFolder.get(f.id) ?? [];
    byId.set(f.id, {
      id: f.id, name: f.name, parentId: f.parentId,
      childFolderIds: childIdsByParent.get(f.id) ?? [],
      drops,
      visibleDropCount: drops.length,
    });
  }

  return {
    byId,
    rootFolderIds: childIdsByParent.get(null) ?? [],
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

## Task 11 — Shared helpers: UUID guard + dashboard render-with-error

**Files:**
- Create: `src/lib/uuid.ts`
- Create: `tests/unit/uuid.test.ts`
- Create: `src/routes/app/dashboardView.ts`

Two small pieces of shared infrastructure used by every folder route.

**`isUuid` guard.** New routes accept UUIDs in `:id` and in body fields. Existing routes validate name-style slugs before hitting the DB (e.g. `src/routes/app/editDrop.ts:13`). Do the same for UUIDs so bad input returns 404/400 cleanly instead of 500.

Unit test (`tests/unit/uuid.test.ts`):

```ts
// ABOUTME: Unit tests for the UUID v4 format guard used at route boundaries.
// ABOUTME: Strict: rejects anything that isn't a 36-char canonical UUID.
import { describe, it, expect } from 'vitest';
import { isUuid } from '@/lib/uuid';

describe('isUuid', () => {
  it('accepts canonical UUIDs', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });
  it('rejects wrong length', () => { expect(isUuid('abc')).toBe(false); });
  it('rejects missing hyphens', () => { expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false); });
  it('rejects non-hex characters', () => { expect(isUuid('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false); });
  it('rejects empty string', () => { expect(isUuid('')).toBe(false); });
});
```

Implementation (`src/lib/uuid.ts`):

```ts
// ABOUTME: Strict UUID format guard for route boundary validation.
// ABOUTME: Matches any valid canonical UUID (any version); version-strict parsing is not needed here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean { return UUID_RE.test(s); }
```

**Dashboard render-with-error helper.** The folder routes need to re-render `dashboard.ejs` with a banner when validation fails (see design plan). Centralise this so every route shares one implementation.

`src/routes/app/dashboardView.ts`:

```ts
// ABOUTME: Shared dashboard render path used by the dashboard route and the folder routes on error.
// ABOUTME: Takes an optional inline error banner and echoes the submitted form values back to the user.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { listFolderTree, type FolderTree } from '@/services/folders';
import { formatBytes } from '@/lib/format';
import { dropOriginFor } from '@/lib/dropHost';

export interface DashboardRenderOptions {
  banner?: { kind: 'error' | 'info'; message: string } | null;
  form?: { kind: 'create-folder' | 'rename-folder' | 'move-folder'; values: Record<string, string> } | null;
  statusCode?: number;
}

export interface FolderPathEntry { id: string; path: string }

export function buildFolderPathList(tree: FolderTree): FolderPathEntry[] {
  const out: FolderPathEntry[] = [];
  function walk(id: string, prefix: string) {
    const node = tree.byId.get(id);
    if (!node) return;
    const path = prefix ? `${prefix} / ${node.name}` : node.name;
    out.push({ id, path });
    for (const childId of node.childFolderIds) walk(childId, path);
  }
  for (const rootId of tree.rootFolderIds) walk(rootId, '');
  return out;
}

export async function renderDashboard(
  req: FastifyRequest, reply: FastifyReply, opts: DashboardRenderOptions = {},
) {
  const user = req.user!;
  const mineOnly = (req.query as { mine?: string }).mine === '1';
  const tree = await listFolderTree({ id: user.id, email: user.email }, { mineOnly });
  const folderPathList = buildFolderPathList(tree);
  if (opts.statusCode) reply.code(opts.statusCode);
  return reply.view('dashboard.ejs', {
    user, tree, mineOnly, folderPathList,
    banner: opts.banner ?? null,
    form: opts.form ?? null,
    csrfToken: req.csrfToken ?? '',
    formatBytes, dropOriginFor,
  });
}
```

`dashboard.ejs` reads `tree`, `folderPathList`, `banner`, and `form` (see Task 18). The view serialises `folderPathList` for the move popover as `<script>window.__folders = <%- JSON.stringify(folderPathList) %>;</script>`.

**Step:** Run the UUID unit tests, then commit:

```bash
git add src/lib/uuid.ts tests/unit/uuid.test.ts src/routes/app/dashboardView.ts
git commit -m "feat(folders): isUuid guard and shared dashboard render helper"
```

---

## Task 12 — Route: POST /app/folders (create)

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

  it('re-renders dashboard with 400 + inline banner on invalid name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=a%2Fb&_csrf=${session.csrf}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.body).toMatch(/Folder name is invalid/);
  });

  it('re-renders dashboard with 400 + inline banner on duplicate sibling name', async () => {
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
    expect(res.body).toMatch(/already exists/);
  });

  it('re-renders dashboard with 400 + banner on malformed parentId (not a UUID)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/app/folders',
      headers: { cookie: session.cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.test' },
      payload: `name=reports&parentId=not-a-uuid&_csrf=${session.csrf}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Invalid folder reference/);
  });
});
```

Inspect existing integration tests (e.g. `tests/integration/new-drop-form.test.ts`) for the real helper names and origin header — adjust if needed.

**Step 2: Run to confirm failure.**

**Step 3: Implement the route.**

The handler uses `renderDashboard` (Task 11) to re-render with an inline banner on validation errors, and validates `parentId` as a UUID at the boundary.

`src/routes/app/folders.ts`:

```ts
// ABOUTME: Folder HTTP routes on the app origin — create, rename, move, delete, plus setDropFolder.
// ABOUTME: All POSTs are CSRF-protected; 303 on success, dashboard re-render with inline banner on validation errors.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import {
  createFolder, renameFolder, moveFolder, deleteFolderReparenting,
  setDropFolder,
  FolderNameTaken, FolderNotFound, FolderCycle, FolderParentNotFound,
  DropNotFound, DropNotVisible,
} from '@/services/folders';
import { InvalidFolderName } from '@/lib/folderName';
import { isUuid } from '@/lib/uuid';
import { renderDashboard } from '@/routes/app/dashboardView';

export const folderRoutes: FastifyPluginAsync = async (app) => {
  app.post('/app/folders', { preHandler: requireCompletedMember }, async (req, reply) => {
    const user = req.user!;
    const body = req.body as { name?: string; parentId?: string };
    const rawParent = body.parentId && body.parentId.length > 0 ? body.parentId : null;
    if (rawParent !== null && !isUuid(rawParent)) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'Invalid folder reference.' },
        form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent } },
      });
    }
    try {
      await createFolder(user.id, body.name ?? '', rawParent);
      return reply.code(303).header('location', '/app').send();
    } catch (e) {
      if (e instanceof InvalidFolderName) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'Folder name is invalid. Use 1–64 characters, no slashes or control characters.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent ?? '' } },
        });
      }
      if (e instanceof FolderNameTaken) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'A folder with that name already exists here.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '', parentId: rawParent ?? '' } },
        });
      }
      if (e instanceof FolderParentNotFound) {
        return renderDashboard(req, reply, {
          statusCode: 400,
          banner: { kind: 'error', message: 'Parent folder not found.' },
          form: { kind: 'create-folder', values: { name: body.name ?? '' } },
        });
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

## Task 13 — Route: POST /app/folders/:id/rename

**Files:**
- Modify: `src/routes/app/folders.ts`
- Modify: `tests/integration/folders-routes.test.ts`

**Step 1: Add failing tests** covering: success (303 + row renamed); 404 on malformed `:id` (not a UUID); 404 on unknown id; 400 with banner on invalid name; 400 with banner on sibling collision; 403 on missing CSRF.

**Step 2: Run.**

**Step 3: Add the handler.**

```ts
app.post('/app/folders/:id/rename', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { name?: string };
  if (!isUuid(id)) return reply.code(404).send('not_found');
  try {
    await renameFolder(id, body.name ?? '');
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof InvalidFolderName) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'Folder name is invalid. Use 1–64 characters, no slashes or control characters.' },
        form: { kind: 'rename-folder', values: { id, name: body.name ?? '' } },
      });
    }
    if (e instanceof FolderNameTaken) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'A folder with that name already exists here.' },
        form: { kind: 'rename-folder', values: { id, name: body.name ?? '' } },
      });
    }
    if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
    throw e;
  }
});
```

**Step 4: Run. Step 5: Commit.**

```bash
git commit -am "feat(folders): POST /app/folders/:id/rename"
```

---

## Task 14 — Route: POST /app/folders/:id/move

Tests cover: move to root (empty `parentId`); move under a parent; 400 with banner on cycle; 400 with banner on collision; 404 on malformed `:id`; 404 on unknown folder; 403 when the CSRF token is missing from the form submission.

Handler:

```ts
app.post('/app/folders/:id/move', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { parentId?: string };
  if (!isUuid(id)) return reply.code(404).send('not_found');
  const rawParent = body.parentId && body.parentId.length > 0 ? body.parentId : null;
  if (rawParent !== null && !isUuid(rawParent)) {
    return renderDashboard(req, reply, {
      statusCode: 400,
      banner: { kind: 'error', message: 'Invalid folder reference.' },
    });
  }
  try {
    await moveFolder(id, rawParent);
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof FolderCycle) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'A folder can\'t be moved inside itself or one of its subfolders.' },
      });
    }
    if (e instanceof FolderNameTaken) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'The target folder already contains a folder with that name.' },
      });
    }
    if (e instanceof FolderParentNotFound) {
      return renderDashboard(req, reply, {
        statusCode: 400,
        banner: { kind: 'error', message: 'The target folder no longer exists. Pick another destination.' },
      });
    }
    if (e instanceof FolderNotFound) return reply.code(404).send('not_found');
    throw e;
  }
});
```

Commit: `git commit -am "feat(folders): POST /app/folders/:id/move"`

---

## Task 15 — Route: POST /app/folders/:id/delete

Tests: success (empty); success with reparent + drops bubble up; 404 on malformed `:id`; 404 on unknown folder; 403 when the CSRF token is missing from the form submission. One explicit test: deleting a folder containing a hidden (`emails`-mode) drop the actor can't see — the transaction must still move that drop up to the parent, and the dashboard the actor saw before the delete reported `visibleDropCount = 0` for that folder (i.e. never mentioned the hidden drop).

Handler:

```ts
app.post('/app/folders/:id/delete', { preHandler: requireCompletedMember }, async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!isUuid(id)) return reply.code(404).send('not_found');
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

## Task 16 — Route: POST /app/drops/:id/folder

**Files:**
- Modify: `src/routes/app/folders.ts`
- Modify: `tests/integration/folders-routes.test.ts`

Tests cover: file own drop (success); unfile (empty `folderId` → null); file another owner's `public`/`authed` drop (success); file another owner's `emails` drop the actor is not listed on (404 — returning 403 would confirm the drop exists); 404 on malformed `:id`; 404 on unknown drop id; dashboard re-render with 400 + banner on unknown/malformed folder id (the folder namespace isn't secret, so it's treated as a stale UI selection); 403 on missing CSRF.

Handler:

```ts
app.post('/app/drops/:id/folder', { preHandler: requireCompletedMember }, async (req, reply) => {
  const user = req.user!;
  const { id } = req.params as { id: string };
  const body = req.body as { folderId?: string };
  if (!isUuid(id)) return reply.code(404).send('not_found');
  const rawFolder = body.folderId && body.folderId.length > 0 ? body.folderId : null;
  const staleFolderBanner = () => renderDashboard(req, reply, {
    statusCode: 400,
    banner: { kind: 'error', message: 'The target folder no longer exists. Pick another destination.' },
  });
  if (rawFolder !== null && !isUuid(rawFolder)) return staleFolderBanner();
  try {
    await setDropFolder({ id: user.id, email: user.email }, id, rawFolder);
    return reply.code(303).header('location', '/app').send();
  } catch (e) {
    if (e instanceof DropNotFound || e instanceof DropNotVisible) return reply.code(404).send('not_found');
    if (e instanceof FolderNotFound) return staleFolderBanner();
    throw e;
  }
});
```

Commit: `git commit -am "feat(folders): POST /app/drops/:id/folder"`

---

## Task 17 — Dashboard route: consume the view model

**Files:**
- Modify: `src/routes/app/dashboard.ts`
- Create: `tests/integration/dashboard-folders.test.ts`

**Step 1:** Write failing integration tests using the inject pattern (match `tests/integration/dashboard.test.ts`):

- GET `/app` renders the folder name in the HTML when the caller has a folder seeded.
- GET `/app` renders a drop inside its folder.
- GET `/app?mine=1` hides another owner's visible drop but still renders that owner's folder.
- Folder badge reflects visible count (e.g. is "0" for a `mine=1` request on a folder containing only someone else's drops).
- `emails`-mode drops hidden from the viewer don't appear in the HTML, and their folder badge reads "0" or the count sans hidden drops.

**Step 2:** Run — expect failure.

**Step 3:** Update the route to use `renderDashboard`:

```ts
// src/routes/app/dashboard.ts
import { renderDashboard } from '@/routes/app/dashboardView';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireCompletedMember }, async (req, reply) => {
    return renderDashboard(req, reply);
  });
};
```

This route and the folder routes now share exactly one render path.

**Step 4:** Tests stay red until Task 18 lands the view. Run after Task 18.

---

## Task 18 — Dashboard view: unified tree

**Files:**
- Modify: `src/views/dashboard.ejs`
- Create: `src/views/_folderNode.ejs`
- Modify: `src/views/static/style.css`
- Create: `tests/e2e/folders.spec.ts`

**Step 1: Write a failing e2e smoke test** at `tests/e2e/folders.spec.ts` using the existing Playwright-as-harness pattern (see `tests/e2e/drop.spec.ts:1-40` — env setup → `buildServer()` → `app.inject()`; this is NOT a browser-driven test). The test seeds a member, creates a folder via `POST /app/folders`, creates a drop via the existing drop-creation path, files it with `POST /app/drops/:id/folder`, then GETs `/app` and asserts the drop's HTML sits inside the folder's block. Then `POST /app/folders/:id/delete` and re-GET `/app`, assert the drop now sits at root.

This file runs under `pnpm test:e2e` as the design plan specifies. No `webServer`/`baseURL` is needed — the existing Playwright spec doesn't use the browser either.

**Step 2:** Run — expect failure (view doesn't render the tree yet).

**Step 3:** Implement the view.

Required affordances, each concrete:

- **`New folder` modal** (button in the page head, next to `New drop`). The modal wraps a `<form method="post" action="/app/folders">` with:
  - `<input name="name">` (text, required, maxlength 64)
  - `<select name="parentId">` with options built from `folderPathList` — first option `<option value="">— root —</option>`, then one option per entry (value = `id`, label = `path`)
  - hidden `_csrf` input
  The modal opens via a button that toggles the `<dialog>` `[open]` attribute; no JS framework, just a small `<script>` snippet that wires click → `dialog.showModal()`.
  On 400 re-render with `form.kind === 'create-folder'`, the modal opens on page load (check `form.kind` in EJS and call `showModal()` in an inline script), the `name` input is prefilled with `form.values.name`, and the `parentId` select has `form.values.parentId` preselected. The banner sits above the main content.

- **Rename affordance.** Each folder row has a `✎` icon button that reveals an inline `<form method="post" action="/app/folders/:id/rename">` with a text input prefilled with the current name and a save/cancel button. Server-rendered; toggled open/closed with a CSS-only `[open]` attribute on a wrapping `<details>`, no JS. On 400 re-render with `form.kind === 'rename-folder'`, the row whose `id === form.values.id` renders with its rename form expanded and the input prefilled.

- **Move popover** (folder or drop). Click `⇆` on the row → a popover listing every entry in `folderPathList` plus `— root —`. Picking an option submits a tiny form — `POST /app/folders/:id/move` for a folder, `POST /app/drops/:id/folder` for a drop. `form.kind === 'move-folder'` doesn't need to reopen the popover on re-render (the banner carries the error; the user picks again).

- **Delete confirmation.** A `<dialog>` populated from the trigger's data attributes with the folder's name, direct `visibleDropCount`, direct `childFolderIds.length`, and the destination folder name (parent or "root"). Form posts to `/app/folders/:id/delete`.

- **Empty-folder placeholder.** When a folder's `visibleDropCount === 0` and `childFolderIds.length === 0`, the partial emits a single muted `<div class="empty">(empty)</div>` in place of where the child list would go. Applies to `mine=1` and `emails`-hidden cases too — a folder that's populated globally but empty for this viewer still renders `(empty)`.

- **`Mine only` checkbox** inside `<form method="get" action="/app">` that submits on change (or a plain link toggle). No JS state.

- **Banner.** If `banner` is set, render `<div class="banner banner-<%= banner.kind %>"><%= banner.message %></div>` at the top of the page.

- **Recursive partial.** `_folderNode.ejs` takes a `node` (a `FolderNode`) and `tree`; emits the folder row (name, `visibleDropCount` badge, icon actions, rename form) and either the empty placeholder or a children block (subfolders via recursion through `tree.byId.get(childId)`, then drops). Called once per `tree.rootFolderIds` entry from `dashboard.ejs`.

- **Drop rows.** Preserve the existing drop-row rendering from today's dashboard: the per-drop host URL (via `dropOriginFor(ownerUsername, name)`), file count, size bar (via `formatBytes`), and the `public`/`list` tag when applicable. Owner pill always rendered (mixed-owner tree). Suppress `Edit` when `d.ownerId !== user.id`. Actions: open, move, (edit for own).

- **Folder path list** inlined for the move popover as `<script>window.__folders = <%- JSON.stringify(folderPathList) %>;</script>`.

The render helper (Task 11) already computes `folderPathList`. This task does not modify `src/routes/app/dashboardView.ts`.

Tests to add for the view (integration, not e2e) beyond Task 17's:

- Empty folder with no drops and no subfolders renders the `(empty)` placeholder.
- Folder with only drops hidden from the current viewer renders `(empty)` for that viewer and the full content for an authorised viewer.
- 400 re-render with `form.kind === 'rename-folder'` emits the rename form expanded on the right row with the submitted name prefilled.
- 400 re-render with `form.kind === 'create-folder'` opens the new-folder modal with the submitted name prefilled.

**Step 4:** Run `pnpm test` — Task 17's dashboard tests and Task 18's view tests should now pass.

**Step 5: Commit.**

```bash
git add src/routes/app/dashboard.ts src/views/dashboard.ejs src/views/_folderNode.ejs src/views/static/style.css tests/integration/dashboard-folders.test.ts tests/e2e/folders.spec.ts
git commit -m "feat(folders): dashboard tree, mine-only toggle, move/delete UX"
```

---

## Task 19 — Design-critical test coverage

**Files:**
- Modify: `tests/integration/folders.test.ts`
- Modify: `tests/integration/folders-routes.test.ts` or a new `tests/integration/folders-safety.test.ts`

Covers the design-plan test cases that aren't exercised by earlier tasks.

**Case A — Advisory-lock race.** Two concurrent `moveFolder` calls that would together create a cycle. Start with `A → B → C` (A is a child of B; B is a child of C, i.e. A is a descendant of B). Spawn two promises: `moveFolder(C, A.id)` and `moveFolder(A, C.id)` concurrently. With the lock, both transactions serialise; the one that runs second sees the tree after the first and rejects with `FolderCycle`. Without the lock, both could pass their cycle check and produce a cycle. Assert that exactly one of the two rejects with `FolderCycle` and that the surviving tree is acyclic (walk ancestors from every folder, expect no revisits).

**Case B — Hidden-drop reparenting.** Seed owner O with an `emails`-mode drop D inside folder F, not listed for viewer V. V calls `POST /app/folders/:id/delete` on F. Assert (via a direct DB read) that D's `folder_id` now matches F's parent (or null). V's subsequent GET `/app` doesn't mention D; O's GET `/app` shows D at the new location.

**Case C — `ON DELETE SET NULL` safety net.** Insert a drop into a folder. Delete the folder row directly (`db.delete(folders).where(...)`) bypassing the service. Assert the drop's `folder_id` is now `NULL` and the row still exists.

**Case D — Delete-confirmation copy has no hidden caveat.** The design forbids leaking hidden drops in the confirmation. Seed a folder with one visible + one hidden drop, render `/app` as the viewer who can only see the visible one, then inspect the HTML (or the dialog's data attributes). Assert the copy mentions "1 drop" and does not contain any "other drops you don't have access to" or similar caveat. Assert the HTML contains no reference to the hidden drop's name.

**Case E — Structural mutation error surfaces the right banner copy.** A rename to a colliding sibling triggers the dashboard re-render with the "already exists" banner. Captured as part of Task 13's tests — explicit check here guards against copy regressions.

**Commit.**

```bash
git commit -am "test(folders): advisory-lock race, hidden reparent, ON DELETE SET NULL, banner copy"
```

---

## Task 20 — Sweep: verify full suite + typecheck + lint

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
