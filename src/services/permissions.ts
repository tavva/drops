// ABOUTME: Per-drop view-permission logic. canView is the single authority used at content-serve time.
// ABOUTME: setViewMode is the only supported way to change a drop's mode.
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { drops } from '@/db/schema';
import { isMemberEmail } from '@/services/allowlist';
import { isViewerAllowed } from '@/services/dropViewers';

export type ViewMode = 'authed' | 'public' | 'emails';

export interface PermUser {
  id: string;
  email: string;
}

export interface PermDrop {
  id: string;
  ownerId: string;
  viewMode: ViewMode | string;
}

export async function canView(user: PermUser, drop: PermDrop): Promise<boolean> {
  if (user.id === drop.ownerId) return true;
  switch (drop.viewMode) {
    case 'public': return true;
    case 'authed': return isMemberEmail(user.email);
    case 'emails': return isViewerAllowed(drop.id, user.email);
    default: return false;
  }
}

export async function setViewMode(dropId: string, mode: ViewMode): Promise<void> {
  await db.update(drops).set({ viewMode: mode }).where(eq(drops.id, dropId));
}
