// ABOUTME: Decides whether an email is allowed to authenticate.
// ABOUTME: Allows any `@ALLOWED_DOMAIN` email plus explicit rows in `allowed_emails`.
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { allowedEmails } from '@/db/schema';
import { config } from '@/config';

export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (normalised.endsWith('@' + config.ALLOWED_DOMAIN)) return true;
  const rows = await db.select().from(allowedEmails).where(eq(allowedEmails.email, normalised));
  return rows.length > 0;
}
