// ABOUTME: Dev-only helper that inserts a user + session and prints the signed cookies.
// ABOUTME: Drops you past the Google OAuth handshake so you can test the app in a local browser.
import { eq } from 'drizzle-orm';
import { db, sql as pg } from '@/db';
import { users, allowedEmails } from '@/db/schema';
import { createSession } from '@/services/sessions';
import { signCookie } from '@/lib/cookies';
import { config } from '@/config';

const email = process.env.SEED_EMAIL ?? 'ben@ben-phillips.net';
const username = process.env.SEED_USERNAME ?? 'ben';

await db.insert(allowedEmails).values({ email }).onConflictDoNothing();

let [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) {
  [user] = await db.insert(users).values({ email, username, name: null, avatarUrl: null }).returning();
}

const sid = await createSession(user!.id);
const signed = signCookie(sid, config.SESSION_SECRET);

const appHost = new URL(config.APP_ORIGIN).host;
const contentHost = new URL(config.CONTENT_ORIGIN).host;

console.log(`
Seeded user: ${user!.username} <${email}>

Paste into Chrome DevTools → Application → Cookies for each origin:

  ${config.APP_ORIGIN}
    Name:  drops_session
    Value: ${signed}
    Path:  /

  ${config.CONTENT_ORIGIN}
    Name:  drops_content_session
    Value: ${signed}
    Path:  /

Or via the document.cookie console (on each origin):

  // on ${appHost}
  document.cookie = 'drops_session=${signed}; path=/';

  // on ${contentHost}
  document.cookie = 'drops_content_session=${signed}; path=/';
`);

await pg.end();
