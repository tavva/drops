// ABOUTME: Resolves identities from verified drop cookies and handoffs for browser and CLI sessions.
// ABOUTME: CLI-backed cookies check revocation on every request and never create app sessions.
import { lookupCliDropSession } from '@/services/cliAuth';
import { getSessionUser, rollIfStale } from '@/services/sessions';

export async function getDropSessionUser(id: string) {
  return id.startsWith('cli:') ? lookupCliDropSession(id) : getSessionUser(id);
}

export async function rollDropSession(id: string) {
  if (!id.startsWith('cli:')) await rollIfStale(id);
}
