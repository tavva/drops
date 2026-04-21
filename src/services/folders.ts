// ABOUTME: Folder CRUD + tree operations. Structural mutations take a transaction-scoped advisory lock.
// ABOUTME: resolveReparentName is exported for unit testing of the delete-time collision rule.
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { folders } from '@/db/schema';
import { cleanFolderName } from '@/lib/folderName';

const REPARENT_ADVISORY_LOCK_KEY = 4137_000_001; // arbitrary constant; documented in the design plan
const MAX_NAME = 64;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string | null;
  createdAt: Date;
}

function toFolder(r: typeof folders.$inferSelect): Folder {
  return { id: r.id, name: r.name, parentId: r.parentId, createdBy: r.createdBy, createdAt: r.createdAt };
}

async function acquireStructuralLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPARENT_ADVISORY_LOCK_KEY})`);
}

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

export async function createFolder(userId: string, rawName: string, parentId?: string | null): Promise<Folder> {
  const name = cleanFolderName(rawName);
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
      return toFolder(row!);
    } catch (e: unknown) {
      if (isUniqueViolation(e)) throw new FolderNameTaken();
      throw e;
    }
  });
}

async function isDescendantOf(tx: Tx, candidateAncestor: string, start: string | null): Promise<boolean> {
  let cur = start;
  const seen = new Set<string>();
  while (cur) {
    if (cur === candidateAncestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const rows = await tx.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, cur));
    if (rows.length === 0) return false;
    cur = rows[0]!.parentId;
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
      return toFolder(row!);
    } catch (e: unknown) {
      if (isUniqueViolation(e)) throw new FolderNameTaken();
      throw e;
    }
  });
}

export async function renameFolder(id: string, rawName: string): Promise<Folder> {
  const name = cleanFolderName(rawName);
  return db.transaction(async (tx) => {
    await acquireStructuralLock(tx);
    const existing = await tx.select().from(folders).where(eq(folders.id, id));
    if (existing.length === 0) throw new FolderNotFound();
    if (existing[0]!.name === name) return toFolder(existing[0]!);
    try {
      const [row] = await tx.update(folders).set({ name }).where(eq(folders.id, id)).returning();
      return toFolder(row!);
    } catch (e: unknown) {
      if (isUniqueViolation(e)) throw new FolderNameTaken();
      throw e;
    }
  });
}

function isUniqueViolation(e: unknown): boolean {
  const visited = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur);
    const obj = cur as { code?: string; cause?: unknown };
    if (obj.code === '23505') return true;
    cur = obj.cause;
  }
  return false;
}

