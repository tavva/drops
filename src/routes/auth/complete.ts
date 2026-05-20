// ABOUTME: Shared viewer login tail — mints a host-bound handoff for a drop target, or falls back
// ABOUTME: to /auth/goodbye. Used by the OAuth callback and the magic-link verify route.
import type { FastifyReply } from 'fastify';
import { createSession } from '@/services/sessions';
import { signHandoff } from '@/lib/handoff';
import { dropTargetFromNext } from '@/lib/dropHost';
import { config } from '@/config';

// dropTargetFromNext recognises both direct drop-host URLs and app-host /auth/drop-bootstrap
// wrappers. The wrapper case is what lets a logged-out viewer who followed a shared drop link
// complete the drop-cookie bootstrap without ever holding an app-session cookie.
export async function completeViewerLogin(
  reply: FastifyReply,
  userId: string,
  next: string,
): Promise<FastifyReply> {
  const sid = await createSession(userId);
  const target = dropTargetFromNext(next);
  if (target) {
    const token = signHandoff(sid, target.hostname, config.SESSION_SECRET, 60);
    const bootstrap = new URL('/auth/bootstrap', target.origin);
    bootstrap.searchParams.set('token', token);
    bootstrap.searchParams.set('next', target.path);
    return reply.redirect(bootstrap.toString(), 302);
  }
  return reply.redirect(new URL('/auth/goodbye', config.APP_ORIGIN).toString(), 302);
}
