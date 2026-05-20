# Magic-link Viewer Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let people without Google accounts view a drop by clicking a one-time sign-in link emailed to an address the owner has already added as a viewer.

**Architecture:** Magic-link auth is a second way to prove ownership of an email; everything downstream (sessions, `canView`, the host-bound handoff) is reused. A `magic_link_tokens` table holds single-use tokens; a `Mailer` abstraction (Resend in prod, Console in dev/test) sends the link; the logged-out drop-bootstrap page gains an "email me a link" option beside Google. The verify step is a non-consuming GET confirmation page plus a consuming POST so email/scanner prefetch cannot burn tokens.

**Tech Stack:** Fastify, TypeScript (ESM, `@/*` paths), Drizzle + Postgres, EJS views, Vitest (unit + integration, single-worker series), Playwright (e2e). Resend via plain `fetch` (no SDK).

**Read first:** `docs/plans/2026-05-20-magic-link-viewer-auth-design.md` (the reviewed design this plan implements).

**Conventions reminder:** every `.ts` starts with two `// ABOUTME:` lines; British English in user copy; match surrounding style. Integration tests need `docker compose up -d`.

---

## Task 1: Mail config keys

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Step 1: Write the failing tests**

Add to `tests/unit/config.test.ts` inside the `describe('loadConfig')` block:

```ts
  it('defaults MAIL_PROVIDER to console', () => {
    process.env = { ...BASE };
    expect(loadConfig().MAIL_PROVIDER).toBe('console');
  });

  it('throws when MAIL_PROVIDER=resend without MAIL_FROM or RESEND_API_KEY', () => {
    process.env = { ...BASE, MAIL_PROVIDER: 'resend' };
    expect(() => loadConfig()).toThrow(/MAIL_FROM/);
  });

  it('accepts resend with MAIL_FROM and RESEND_API_KEY', () => {
    process.env = { ...BASE, MAIL_PROVIDER: 'resend', MAIL_FROM: 'drops@example.com', RESEND_API_KEY: 'rk' };
    expect(loadConfig().MAIL_PROVIDER).toBe('resend');
  });
```

**Step 2: Run to verify they fail**

Run: `pnpm test -- tests/unit/config.test.ts`
Expected: FAIL (MAIL_PROVIDER undefined / no throw).

**Step 3: Implement**

In `src/config.ts`, add to the zod object (after `LOG_LEVEL`):

```ts
  MAIL_PROVIDER: z.enum(['resend', 'console']).default('console'),
  MAIL_FROM: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
```

In `loadConfig`, after the `APP_ORIGIN === CONTENT_ORIGIN` check:

```ts
  if (parsed.MAIL_PROVIDER === 'resend' && (!parsed.MAIL_FROM || !parsed.RESEND_API_KEY)) {
    throw new Error('MAIL_PROVIDER=resend requires MAIL_FROM and RESEND_API_KEY');
  }
```

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/unit/config.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat(config): mail provider settings with fail-fast for resend"
```

---

## Task 2: Mailer abstraction + ConsoleMailer

**Files:**
- Create: `src/lib/mail/types.ts`, `src/lib/mail/console.ts`, `src/lib/mail/index.ts`
- Test: `tests/unit/mailer.test.ts`

**Step 1: Write the failing test**

`tests/unit/mailer.test.ts`:

```ts
// ABOUTME: ConsoleMailer records sent messages so tests can assert on magic-link delivery.
import { describe, it, expect } from 'vitest';
import { ConsoleMailer } from '@/lib/mail/console';

describe('ConsoleMailer', () => {
  it('records each sent message', async () => {
    const m = new ConsoleMailer();
    await m.send({ to: 'a@b.com', subject: 'Hi', text: 'link', html: '<a>link</a>' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ to: 'a@b.com', subject: 'Hi' });
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm test -- tests/unit/mailer.test.ts`
Expected: FAIL (module not found).

**Step 3: Implement**

`src/lib/mail/types.ts`:

```ts
// ABOUTME: Mailer interface — the one seam every email send goes through.
// ABOUTME: Backends are selected by config; see ./index.ts getMailer().
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
```

`src/lib/mail/console.ts`:

```ts
// ABOUTME: Dev/test Mailer that captures messages in-memory for assertions instead of delivering.
// ABOUTME: Records only — no stdout — so test output stays pristine; the route logs sends via pino.
import type { Mailer, MailMessage } from './types';

export class ConsoleMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
```

(It captures rather than prints — the request route already logs a send via `req.log`, and tests run with `LOG_LEVEL=silent`, so nothing pollutes test output. Drop the `console.log` assertion from the Task 2 test if you added one.)

`src/lib/mail/index.ts` (Resend backend added in Task 3; for now wire console + a placeholder import):

```ts
// ABOUTME: Selects and memoises the Mailer backend named by config.MAIL_PROVIDER.
// ABOUTME: 'console' for dev/test; 'resend' for production delivery.
import type { Mailer } from './types';
import { ConsoleMailer } from './console';
import { config } from '@/config';

let cached: Mailer | undefined;

export function getMailer(): Mailer {
  if (cached) return cached;
  cached = config.MAIL_PROVIDER === 'resend'
    ? buildResend()
    : new ConsoleMailer();
  return cached;
}

function buildResend(): Mailer {
  throw new Error('ResendMailer not yet implemented');
}
```

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/unit/mailer.test.ts` → PASS.
Run: `pnpm typecheck` → clean.

**Step 5: Commit**

```bash
git add src/lib/mail tests/unit/mailer.test.ts
git commit -m "feat(mail): Mailer interface and ConsoleMailer"
```

---

## Task 3: ResendMailer

**Files:**
- Create: `src/lib/mail/resend.ts`
- Modify: `src/lib/mail/index.ts`
- Test: `tests/unit/mailer-resend.test.ts`

**Step 1: Write the failing test**

`tests/unit/mailer-resend.test.ts`:

```ts
// ABOUTME: ResendMailer POSTs to the Resend API and throws on non-2xx responses.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResendMailer } from '@/lib/mail/resend';

afterEach(() => vi.restoreAllMocks());

describe('ResendMailer', () => {
  it('POSTs to Resend with auth header and from address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"id":"x"}', { status: 200 }),
    );
    const m = new ResendMailer('rk_test', 'drops@example.com');
    await m.send({ to: 'a@b.com', subject: 'Hi', text: 't', html: '<p>t</p>' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer rk_test');
    expect(JSON.parse(init!.body as string)).toMatchObject({ from: 'drops@example.com', to: 'a@b.com' });
  });

  it('throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }));
    const m = new ResendMailer('rk_test', 'drops@example.com');
    await expect(m.send({ to: 'a@b.com', subject: 'Hi', text: 't', html: '<p>t</p>' }))
      .rejects.toThrow(/422/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm test -- tests/unit/mailer-resend.test.ts` → FAIL (module not found).

**Step 3: Implement**

`src/lib/mail/resend.ts`:

```ts
// ABOUTME: Production Mailer backed by the Resend HTTP API via fetch (no SDK).
// ABOUTME: Throws on non-2xx so callers can log; the request route still shows a neutral notice.
import type { Mailer, MailMessage } from './types';

export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status}`);
    }
  }
}
```

Replace `buildResend` in `src/lib/mail/index.ts`:

```ts
import { ResendMailer } from './resend';
// ...
function buildResend(): Mailer {
  return new ResendMailer(config.RESEND_API_KEY!, config.MAIL_FROM!);
}
```

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/unit/mailer-resend.test.ts` → PASS. `pnpm typecheck` → clean.

**Step 5: Commit**

```bash
git add src/lib/mail/resend.ts src/lib/mail/index.ts tests/unit/mailer-resend.test.ts
git commit -m "feat(mail): ResendMailer over fetch"
```

---

## Task 4: magic_link_tokens schema + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: migration under `src/db/migrations/` (generated)

**Step 1: Add the table to `src/db/schema.ts`**

After `dropViewers`:

```ts
export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  next: text('next').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  liveLookupIdx: index('magic_link_tokens_email_drop_idx').on(t.email, t.dropId),
}));
```

**Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `src/db/migrations/000N_*.sql` creating the table. Open it and confirm it `CREATE TABLE "magic_link_tokens"` with the FK and index. No raw-SQL step needed (unlike `drops.current_version`).

**Step 3: Apply against the test DB and typecheck**

Run: `docker compose up -d` (if not already), then `pnpm typecheck`.
The test harness rebuilds the test DB from migrations on the next `pnpm test` run, so no manual migrate needed for tests. (For local dev: `pnpm db:migrate`.)

**Step 4: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat(db): magic_link_tokens table"
```

---

## Task 5: Token service (create with dedupe, consume)

**Files:**
- Create: `src/services/magicLinkTokens.ts`
- Test: `tests/integration/magic-link-tokens.test.ts`

The create path must be atomic so two concurrent requests for the same `(email, dropId)` cannot both send. Use a transaction with a per-key advisory lock, then look for a live (unconsumed, unexpired) token; reuse it if present, otherwise insert. Return whether a new token was created (the route uses this only to decide whether to send — the user-visible response is identical either way).

**Step 1: Write the failing tests**

`tests/integration/magic-link-tokens.test.ts`:

```ts
// ABOUTME: magic_link_tokens service — single-use consume and per-(email,drop) send dedupe.
import { describe, it, expect, beforeEach } from 'vitest';

let ownerId: string;
let dropId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, magicLinkTokens } = await import('@/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  ownerId = u!.id;
  const [d] = await db.insert(drops).values({ ownerId, name: 'foo', viewMode: 'emails' }).returning();
  dropId = d!.id;
});

describe('issueMagicToken', () => {
  it('creates a token the first time and reuses it the second', async () => {
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    const a = await issueMagicToken('viewer@x.com', dropId, '/a.html');
    const b = await issueMagicToken('viewer@x.com', dropId, '/b.html');
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);   // same outstanding token reused
  });

  it('normalises the email', async () => {
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    const a = await issueMagicToken('Viewer@X.com', dropId, '/');
    const b = await issueMagicToken('viewer@x.com', dropId, '/');
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);
  });
});

describe('consumeMagicToken', () => {
  it('consumes exactly once', async () => {
    const { issueMagicToken, consumeMagicToken } = await import('@/services/magicLinkTokens');
    const { token } = await issueMagicToken('viewer@x.com', dropId, '/x.html');
    const first = await consumeMagicToken(token);
    expect(first).toMatchObject({ email: 'viewer@x.com', dropId, next: '/x.html' });
    const second = await consumeMagicToken(token);
    expect(second).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const { consumeMagicToken } = await import('@/services/magicLinkTokens');
    expect(await consumeMagicToken('nope')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { consumeMagicToken } = await import('@/services/magicLinkTokens');
    await db.insert(magicLinkTokens).values({
      id: 'expired-tok', email: 'viewer@x.com', dropId, next: '/',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeMagicToken('expired-tok')).toBeNull();
  });
});

describe('issueMagicToken dedupe vs expiry', () => {
  it('an expired outstanding token does not dedupe a new request', async () => {
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { issueMagicToken } = await import('@/services/magicLinkTokens');
    await db.insert(magicLinkTokens).values({
      id: 'stale-tok', email: 'viewer@x.com', dropId, next: '/',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fresh = await issueMagicToken('viewer@x.com', dropId, '/');
    expect(fresh.created).toBe(true);
    expect(fresh.token).not.toBe('stale-tok');
  });
});
```

**Step 2: Run to verify they fail**

Run: `pnpm test -- tests/integration/magic-link-tokens.test.ts` → FAIL (module not found).

**Step 3: Implement `src/services/magicLinkTokens.ts`**

```ts
// ABOUTME: Single-use magic-link tokens for email-based viewer auth, with per-(email,drop) send dedupe.
// ABOUTME: issue is atomic under a per-key advisory lock; consume is an atomic claim of one row.
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { magicLinkTokens } from '@/db/schema';
import { normaliseEmail } from '@/lib/email';

export const MAGIC_TTL_SECONDS = 15 * 60;

export interface IssuedToken {
  token: string;
  created: boolean;
}

export interface ConsumedToken {
  email: string;
  dropId: string;
  next: string;
}

function lockKey(email: string, dropId: string): bigint {
  const h = createHash('sha256').update(`${email}:${dropId}`).digest();
  return h.readBigInt64BE(0);
}

export async function issueMagicToken(email: string, dropId: string, next: string): Promise<IssuedToken> {
  const normalised = normaliseEmail(email);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(normalised, dropId)})`);
    const [live] = await tx.select({ id: magicLinkTokens.id })
      .from(magicLinkTokens)
      .where(and(
        eq(magicLinkTokens.email, normalised),
        eq(magicLinkTokens.dropId, dropId),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ))
      .limit(1);
    if (live) return { token: live.id, created: false };

    const token = randomBytes(32).toString('base64url');
    await tx.insert(magicLinkTokens).values({
      id: token,
      email: normalised,
      dropId,
      next,
      expiresAt: new Date(Date.now() + MAGIC_TTL_SECONDS * 1000),
    });
    return { token, created: true };
  });
}

export async function consumeMagicToken(token: string): Promise<ConsumedToken | null> {
  const rows = await db.update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(magicLinkTokens.id, token),
      isNull(magicLinkTokens.consumedAt),
      gt(magicLinkTokens.expiresAt, new Date()),
    ))
    .returning({ email: magicLinkTokens.email, dropId: magicLinkTokens.dropId, next: magicLinkTokens.next });
  return rows[0] ?? null;
}

export async function deleteExpiredMagicTokens(): Promise<void> {
  await db.delete(magicLinkTokens)
    .where(sql`${magicLinkTokens.consumedAt} IS NOT NULL OR ${magicLinkTokens.expiresAt} <= now()`);
}
```

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/magic-link-tokens.test.ts` → PASS.

**Step 5: Commit**

```bash
git add src/services/magicLinkTokens.ts tests/integration/magic-link-tokens.test.ts
git commit -m "feat(auth): magic-link token service (atomic issue + consume)"
```

---

## Task 6: canViewByEmail (eligibility mirrors canView)

**Files:**
- Modify: `src/services/permissions.ts`
- Test: `tests/integration/can-view-by-email.test.ts`

**Step 1: Write the failing tests**

`tests/integration/can-view-by-email.test.ts`:

```ts
// ABOUTME: canViewByEmail mirrors canView across viewModes for an email with no user id yet.
import { describe, it, expect, beforeEach } from 'vitest';

let ownerId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops); await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  ownerId = u!.id;
});

async function makeDrop(viewMode: string) {
  const { db } = await import('@/db');
  const { drops } = await import('@/db/schema');
  const [d] = await db.insert(drops).values({ ownerId, name: `d-${viewMode}`, viewMode }).returning();
  return d!;
}

describe('canViewByEmail', () => {
  it('owner email always allowed', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('emails');
    expect(await canViewByEmail('alice@example.com', d)).toBe(true);
  });
  it('public: any email', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    expect(await canViewByEmail('stranger@nowhere.com', await makeDrop('public'))).toBe(true);
  });
  it('authed: only member emails', async () => {
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('authed');
    expect(await canViewByEmail('bob@example.com', d)).toBe(true);     // ALLOWED_DOMAIN
    expect(await canViewByEmail('bob@other.com', d)).toBe(false);
  });
  it('emails: only listed viewers', async () => {
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    const { canViewByEmail } = await import('@/services/permissions');
    const d = await makeDrop('emails');
    await db.insert(dropViewers).values({ dropId: d.id, email: 'listed@x.com' });
    expect(await canViewByEmail('listed@x.com', d)).toBe(true);
    expect(await canViewByEmail('unlisted@x.com', d)).toBe(false);
  });
});
```

**Step 2: Run to verify they fail**

Run: `pnpm test -- tests/integration/can-view-by-email.test.ts` → FAIL.

**Step 3: Implement**

In `src/services/permissions.ts`, add `findByEmail` import and `canViewByEmail`, then make `canView` delegate:

```ts
import { findByEmail } from '@/services/users';
// ...
export async function canViewByEmail(email: string, drop: PermDrop): Promise<boolean> {
  if (drop.viewMode === 'public') return true;
  const owner = await findByEmail(email);
  if (owner?.id === drop.ownerId) return true;
  switch (drop.viewMode) {
    case 'authed': return isMemberEmail(email);
    case 'emails': return isViewerAllowed(drop.id, email);
    default: return false;
  }
}

export async function canView(user: PermUser, drop: PermDrop): Promise<boolean> {
  if (user.id === drop.ownerId) return true;
  return canViewByEmail(user.email, drop);
}
```

The owner is resolved by email up front (skipping the lookup only for `public`, where everyone passes), so the Task 6 "owner email always allowed" test passes for an `emails` drop. `canView` keeps its own id-based owner short-circuit for the hot path.

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/can-view-by-email.test.ts` → PASS.
Run: `pnpm test -- tests/integration/auth-drop-bootstrap.test.ts` → still PASS (canView unchanged behaviour).

**Step 5: Commit**

```bash
git add src/services/permissions.ts tests/integration/can-view-by-email.test.ts
git commit -m "feat(auth): canViewByEmail mirrors canView; canView delegates"
```

---

## Task 7: Extract completeViewerLogin

**Files:**
- Create: `src/routes/auth/complete.ts`
- Modify: `src/routes/auth/callback.ts`
- Test: existing `tests/integration/auth-callback.test.ts` must stay green

**Step 1: Create the shared helper `src/routes/auth/complete.ts`**

```ts
// ABOUTME: Shared viewer login tail — mints a host-bound handoff for a drop target, or falls back
// ABOUTME: to /auth/goodbye. Used by the OAuth callback and the magic-link verify route.
import type { FastifyReply } from 'fastify';
import { createSession } from '@/services/sessions';
import { signHandoff } from '@/lib/handoff';
import { dropTargetFromNext } from '@/lib/dropHost';
import { config } from '@/config';

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
```

**Step 2: Refactor `callback.ts` to use it for the viewer branch**

In `completeLogin` (callback.ts), the viewer path currently: mints handoff if `dropTarget`, else redirects to `/auth/goodbye`. Replace the viewer-branch body so that when `kind === 'viewer'` it calls `completeViewerLogin(reply, userId, nextUrl)`. Keep the member branch (app cookie + member redirect) exactly as-is. Concretely, `completeLogin` becomes:

Keep the existing typed signature (`Kind` and `FastifyReply` are already in scope in `callback.ts`):

```ts
async function completeLogin(
  reply: FastifyReply,
  userId: string,
  kind: Kind,
  nextUrl: string,
): Promise<FastifyReply> {
  if (kind === 'viewer') {
    return completeViewerLogin(reply, userId, nextUrl);
  }
  const sid = await createSession(userId);
  reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({ maxAge: 30 * 24 * 3600 }));
  const dropTarget = dropTargetFromNext(nextUrl);
  if (dropTarget) {
    const token = signHandoff(sid, dropTarget.hostname, config.SESSION_SECRET, 60);
    const bootstrap = new URL('/auth/bootstrap', dropTarget.origin);
    bootstrap.searchParams.set('token', token);
    bootstrap.searchParams.set('next', dropTarget.path);
    return reply.redirect(bootstrap.toString(), 302);
  }
  return reply.redirect(nextUrl, 302);
}
```

Add `import { completeViewerLogin } from './complete';`. Preserve the existing explanatory comment about the wrapper case (move it onto `completeViewerLogin` or keep it in `complete.ts`). Confirm a `/auth/goodbye` route exists (it does — referenced by the current viewer path); if not, this refactor must not introduce a new dangling route.

**Step 3: Run the existing callback tests**

Run: `pnpm test -- tests/integration/auth-callback.test.ts`
Expected: PASS unchanged — this is a pure extraction.

**Step 4: Typecheck**

Run: `pnpm typecheck` → clean.

**Step 5: Commit**

```bash
git add src/routes/auth/complete.ts src/routes/auth/callback.ts
git commit -m "refactor(auth): extract completeViewerLogin shared by callback and magic-link"
```

---

## Task 8: Anonymous CSRF context

**Files:**
- Modify: `src/middleware/csrf.ts`
- Create: helper in `src/lib/csrf.ts` (cookie name + mint/read)
- Test: `tests/integration/csrf.test.ts` (add a case) or new `tests/integration/csrf-anon.test.ts`

The logged-out interstitial needs a CSRF context. Add a signed `csrf_anon` cookie holding a random id, and make `contextId` fall back to it.

**Step 1: Write the failing test**

`tests/integration/csrf-anon.test.ts`: build an app-host instance with `registerCsrf` and a tiny test route that is CSRF-protected, set a `csrf_anon` cookie (signed) plus a matching `drops_csrf` token bound to that anon id, POST with correct origin, and assert it is **not** rejected with `no_csrf_context`. Mirror the structure of the existing `tests/integration/csrf.test.ts`. (Read that file first for the exact harness pattern.)

**Step 2: Run to verify it fails**

Run: `pnpm test -- tests/integration/csrf-anon.test.ts` → FAIL (currently `no_csrf_context`).

**Step 3: Implement**

In `src/lib/csrf.ts` add:

```ts
export const CSRF_ANON_COOKIE = 'csrf_anon';
```

In `src/middleware/csrf.ts`, import `CSRF_ANON_COOKIE` (it already imports `verifyCookie`; do **not** add `signCookie` here — the cookie is *set* by the route in Tasks 9–10, only *read* here), then extend `contextId`:

```ts
function anonContextId(req: FastifyRequest): string | null {
  const raw = req.cookies[CSRF_ANON_COOKIE];
  if (!raw) return null;
  return verifyCookie(raw, config.SESSION_SECRET);
}

function contextId(req: FastifyRequest): string | null {
  return req.session?.id ?? req.pendingLogin?.id ?? sessionIdFromCookie(req) ?? anonContextId(req);
}
```

Export a small helper used by the interstitial route (Task 9) to mint the pair — put it in `src/lib/csrf.ts`:

```ts
import { randomBytes } from 'node:crypto';
// A fresh anonymous CSRF context id. The route signs it into the csrf_anon cookie and
// binds the form's drops_csrf token to it via issueCsrfToken(anonId).
export function newAnonCsrfId(): string {
  return randomBytes(18).toString('base64url');
}
```

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/csrf-anon.test.ts` → PASS.
Run: `pnpm test -- tests/integration/csrf.test.ts` → still PASS.

**Step 5: Commit**

```bash
git add src/lib/csrf.ts src/middleware/csrf.ts tests/integration/csrf-anon.test.ts
git commit -m "feat(csrf): anonymous CSRF context via signed csrf_anon cookie"
```

---

## Task 9: Interstitial page + dropBootstrap change

**Files:**
- Create: `src/views/dropSignin.ejs`
- Modify: `src/routes/auth/dropBootstrap.ts`
- Test: update `tests/integration/auth-drop-bootstrap.test.ts` (the no-session case changes), add interstitial assertions

**Behaviour change:** today, `GET /auth/drop-bootstrap` with no app session 302s to `/auth/login`. It will instead render `dropSignin.ejs` (200) offering Google **and** the email form. The existing test `bounces to /auth/login when no app session` must be rewritten to expect the interstitial.

**Step 1: Update the failing test**

In `tests/integration/auth-drop-bootstrap.test.ts`, replace the `bounces to /auth/login...` test with:

```ts
  it('renders the sign-in interstitial when no app session', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2F',
      null,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/auth/login');                 // Google option present
    expect(res.body).toContain('/auth/magic/request');         // email form present
    expect(res.headers['set-cookie']).toBeDefined();           // csrf_anon + drops_csrf set
  });
```

The `beforeAll` for this test registers `dropBootstrapRoute` directly; it must now also `registerCsrf` so the interstitial can mint a token, and the app must be able to render views. Read the top of `tests/integration/new-drop-form.test.ts` for how a view-rendering route is set up in tests, and mirror it (it uses `buildServer` which already wires `@fastify/view`).

**Step 2: Run to verify it fails**

Run: `pnpm test -- tests/integration/auth-drop-bootstrap.test.ts` → FAIL.

**Step 3: Implement the view**

`src/views/dropSignin.ejs` — model it on `chooseUsername.ejs` (same head/styles/logo). Body: show the drop being requested (`<%= host %>`), a *Sign in with Google* link to `<%= googleHref %>`, and a form:

```html
<form method="post" action="/auth/magic/request">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <input type="hidden" name="host" value="<%= host %>">
  <input type="hidden" name="next" value="<%= next %>">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <button class="btn primary" type="submit">Email me a sign-in link →</button>
</form>
<% if (notice) { %><p class="notice"><%= notice %></p><% } %>
```

**Step 3b: Implement the route change**

In `src/routes/auth/dropBootstrap.ts`, replace the no-session branch (the block that builds `login` and redirects) with rendering the interstitial. Add imports for `issueCsrfToken`, `CSRF_COOKIE`, `CSRF_ANON_COOKIE`, `newAnonCsrfId`, `signCookie`, `appCookieOptions`. The Google href is the existing self-wrapped login URL:

```ts
const session = await resolveSession(req);
if (!session) {
  const selfUrl = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  selfUrl.searchParams.set('host', host);
  selfUrl.searchParams.set('next', nextPath);
  const googleHref = new URL('/auth/login', config.APP_ORIGIN);
  googleHref.searchParams.set('next', selfUrl.toString());

  const anonId = newAnonCsrfId();
  reply.setCookie(CSRF_ANON_COOKIE, signCookie(anonId, config.SESSION_SECRET), appCookieOptions());
  const csrfToken = issueCsrfToken(anonId);
  reply.setCookie(CSRF_COOKIE, csrfToken, appCookieOptions({ httpOnly: false }));

  return reply.view('dropSignin.ejs', {
    host,
    next: nextPath,
    googleHref: googleHref.toString(),
    csrfToken,
    notice: null,
  });
}
```

Leave the rest of the route (owner/canView/handoff) unchanged.

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/auth-drop-bootstrap.test.ts` → PASS (all cases). `pnpm typecheck` → clean.

**Step 5: Commit**

```bash
git add src/views/dropSignin.ejs src/routes/auth/dropBootstrap.ts tests/integration/auth-drop-bootstrap.test.ts
git commit -m "feat(auth): drop sign-in interstitial offering Google or magic link"
```

---

## Task 10: POST /auth/magic/request

**Files:**
- Create: `src/routes/auth/magic.ts` (request handler; verify added in Task 11)
- Test: `tests/integration/magic-request.test.ts`

The route: origin-check + anon CSRF (via the registered CSRF middleware — do **not** set `skipCsrf`), `tightAuthLimit`. Steps: parse `host`→drop; normalise email; if `!isLikelyEmail` → neutral re-render; if `!canViewByEmail` → neutral re-render; else `issueMagicToken`, and if `created` send the link via `getMailer()` (after deciding the response, errors logged). **Always** re-render the interstitial with the neutral notice.

**Step 1: Write the failing tests**

`tests/integration/magic-request.test.ts` (read `auth-drop-bootstrap.test.ts` for the harness; register `dropBootstrapRoute` + `magicRoutes` + `registerCsrf`). To submit valid CSRF, first GET the interstitial, capture `drops_csrf` + `csrf_anon` from `set-cookie`, and replay them with `_csrf` in the body and an `origin: http://drops.localtest.me:3000` header. **Every POST `inject` must set `'content-type': 'application/x-www-form-urlencoded'`** and pass a urlencoded string `payload` — without it `@fastify/formbody` won't populate `req.body`, so both the CSRF check and the email read would see empty values. Tests:

```ts
// allowlisted viewer → 200, notice present, one token row, one ConsoleMailer message
// non-allowlisted email → 200, SAME notice, zero token rows, zero sends
// malformed email (e.g. "nope") → 200, SAME notice, zero token rows, zero sends
// invalid host/next (no such drop target) → no token, no send
// second request same (email, drop) with a DIFFERENT valid next path → still one message, one token row
```

Enumeration-safety assertion: compare the eligible and ineligible responses on `statusCode` and on the notice text (e.g. both `res.body.includes(NOTICE)`), **not** raw body equality — the embedded `drops_csrf` token differs every render by design. The security guarantee under test is "zero token rows + zero sends for ineligible/malformed", which is observable in the DB and the mailer.

Assert message capture via the memoised mailer: `const { getMailer } = await import('@/lib/mail'); const mailer = getMailer() as { sent: unknown[] };` then read `mailer.sent.length`. `MAIL_PROVIDER` defaults to `console` under test (TEST_ENV omits it). Because `getMailer()` memoises, clear `mailer.sent.length = 0` in `beforeEach` alongside deleting `magic_link_tokens` rows.

**Step 2: Run to verify they fail**

Run: `pnpm test -- tests/integration/magic-request.test.ts` → FAIL (route missing).

**Step 3: Implement `src/routes/auth/magic.ts`** (request half)

```ts
// ABOUTME: Magic-link viewer auth — POST /auth/magic/request emails a one-time sign-in link
// ABOUTME: to an eligible address; GET/POST /auth/magic/verify (Task 11) complete the login.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parseDropHost, dropTargetFromNext } from '@/lib/dropHost';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canViewByEmail } from '@/services/permissions';
import { issueMagicToken } from '@/services/magicLinkTokens';
import { isLikelyEmail, normaliseEmail } from '@/lib/email';
import { issueCsrfToken, CSRF_COOKIE, CSRF_ANON_COOKIE, newAnonCsrfId } from '@/lib/csrf';
import { signCookie, appCookieOptions } from '@/lib/cookies';
import { getMailer } from '@/lib/mail';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

const NOTICE = 'If that address can view this drop, a sign-in link is on its way.';

interface InterstitialParams { host: string; next: string; notice: string | null; }

function renderInterstitial(reply: FastifyReply, { host, next, notice }: InterstitialParams): FastifyReply {
  const anonId = newAnonCsrfId();
  reply.setCookie(CSRF_ANON_COOKIE, signCookie(anonId, config.SESSION_SECRET), appCookieOptions());
  const csrfToken = issueCsrfToken(anonId);
  reply.setCookie(CSRF_COOKIE, csrfToken, appCookieOptions({ httpOnly: false }));
  const selfUrl = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  selfUrl.searchParams.set('host', host); selfUrl.searchParams.set('next', next);
  const googleHref = new URL('/auth/login', config.APP_ORIGIN);
  googleHref.searchParams.set('next', selfUrl.toString());
  return reply.view('dropSignin.ejs', { host, next, googleHref: googleHref.toString(), csrfToken, notice });
}

// A clean same-host path: starts with a single '/'. Anything else (absolute URL, // ,
// protocol-relative) is rejected rather than silently coerced.
function sameHostPath(raw: string | undefined): string | null {
  if (!raw) return '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

// Build the wrapped /auth/drop-bootstrap resume URL and validate it points at a real drop target.
// Returns null when host/next don't resolve — the route then no-ops (no token, neutral notice).
function wrappedNext(host: string, next: string): string | null {
  const wrapped = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  wrapped.searchParams.set('host', host);
  wrapped.searchParams.set('next', next);
  return dropTargetFromNext(wrapped.toString()) ? wrapped.toString() : null;
}

export const magicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/magic/request', { config: tightAuthLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const host = (body.host ?? '').toLowerCase();
    const parsed = parseDropHost(host);
    if (!parsed) return reply.code(404).send('not_found');
    const next = sameHostPath(body.next);   // null when the supplied next is not a clean path
    const email = (body.email ?? '').trim();

    const issueAndSend = async () => {
      if (!isLikelyEmail(email)) return;
      if (next === null) return;                            // invalid next → no token, no send
      const resume = wrappedNext(host, next);
      if (!resume) return;                                  // next/host not a valid drop target
      const owner = await findByUsername(parsed.username);
      const drop = owner ? await findByOwnerAndName(owner.id, parsed.dropname) : null;
      if (!drop) return;
      if (!(await canViewByEmail(email, { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode }))) return;
      const { token, created } = await issueMagicToken(email, drop.id, resume);
      if (!created) return;
      const link = new URL('/auth/magic/verify', config.APP_ORIGIN);
      link.searchParams.set('token', token);
      try {
        await getMailer().send({
          to: normaliseEmail(email),
          subject: 'Your sign-in link',
          text: `Sign in to view this drop:\n${link.toString()}\nThis link expires in 15 minutes.`,
          html: `<p><a href="${link.toString()}">Sign in to view this drop</a></p><p>Expires in 15 minutes.</p>`,
        });
        req.log.info({ drop_id: drop.id }, 'magic link sent');
      } catch (e) { req.log.warn({ err: e }, 'magic link send failed'); }
    };
    await issueAndSend();
    return renderInterstitial(reply, { host, next: next ?? '/', notice: NOTICE });
  });
};
```

The `next` stored on the token is the **wrapped** `/auth/drop-bootstrap?host=…&next=…` URL, which `dropTargetFromNext` unwraps at verify time (see `dropHost.ts`). Validating it with `dropTargetFromNext` at request time satisfies the design's "`next` validated on the way in" — a bad host/path issues no token.

**On enumeration-safety and the CSRF token:** every render rotates `csrf_anon` and embeds a fresh `drops_csrf` token, so two responses are never literally byte-for-byte equal. What must be identical between eligible and ineligible (and malformed) inputs is the **status code and the visible notice**, with the only differences confined to that random CSRF token. The test below asserts exactly that, not raw byte-equality.

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/magic-request.test.ts` → PASS. `pnpm typecheck` → clean.

**Step 5: Commit**

```bash
git add src/routes/auth/magic.ts tests/integration/magic-request.test.ts
git commit -m "feat(auth): POST /auth/magic/request emails a sign-in link (enumeration-safe)"
```

---

## Task 11: GET + POST /auth/magic/verify

**Files:**
- Modify: `src/routes/auth/magic.ts`
- Create: `src/views/magicConfirm.ejs`, `src/views/magicExpired.ejs`
- Test: `tests/integration/magic-verify.test.ts`

GET renders a confirmation page with a POST button and the token in a hidden field — it does **not** consume. POST (origin-checked, `skipCsrf`, token is the capability) consumes and runs `completeViewerLogin`.

**Step 1: Write the failing tests**

`tests/integration/magic-verify.test.ts`:

```ts
// GET /auth/magic/verify?token=… renders confirm page, token NOT consumed (POST later still works)
// GET with a malformed token (wrong shape) → 400 + magicExpired.ejs
// POST /auth/magic/verify with token → creates kind='viewer' user, 302 to drop-host /auth/bootstrap with handoff
// POST replay with same token → magicExpired.ejs, no new session
// member email via magic link → content session, member row kind unchanged
```

Seed a drop with `viewMode='emails'` and a listed viewer, issue a token via `issueMagicToken(email, dropId, wrappedNext)`, then drive the routes. The POST-verify `inject` calls must set `'content-type': 'application/x-www-form-urlencoded'` and an `origin: http://drops.localtest.me:3000` header, with a urlencoded `payload` (e.g. `token=${token}`) — otherwise `req.body` is empty and the origin check / token read fail. For the redirect assertion, mirror `auth-drop-bootstrap.test.ts`: parse `location`, expect origin `http://alice--foo.content.localtest.me:3000`, pathname `/auth/bootstrap`, and a `verifyHandoff` that returns `{ ok: true }`. For "GET not consumed", assert the `magic_link_tokens` row's `consumedAt` is still null after the GET.

**Step 2: Run to verify they fail**

Run: `pnpm test -- tests/integration/magic-verify.test.ts` → FAIL.

**Step 3: Implement** — add to `src/routes/auth/magic.ts`:

```ts
import { requestOriginOk } from '@/lib/csrf';
import { consumeMagicToken } from '@/services/magicLinkTokens';
import { findByEmail, createViewerUser } from '@/services/users';
import { completeViewerLogin } from './complete';

// Tokens are randomBytes(32).toString('base64url') → exactly 43 base64url chars.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

  app.get('/auth/magic/verify', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const token = (req.query as Record<string, string | undefined>).token ?? '';
    if (!TOKEN_SHAPE.test(token)) return reply.code(400).view('magicExpired.ejs', {});
    return reply.view('magicConfirm.ejs', { token });   // does NOT consume
  });

  app.post('/auth/magic/verify', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!requestOriginOk(origin, referer)) return reply.code(403).send('bad_origin');
    const token = ((req.body ?? {}) as Record<string, string | undefined>).token ?? '';
    const claimed = await consumeMagicToken(token);
    if (!claimed) return reply.code(400).view('magicExpired.ejs', {});
    const existing = await findByEmail(claimed.email);
    const user = existing ?? await createViewerUser({ email: claimed.email, name: null, avatarUrl: null });
    return completeViewerLogin(reply, user.id, claimed.next);
  });
```

`magicConfirm.ejs` (model on `chooseUsername.ejs` styling): one form `POST /auth/magic/verify` with `<input type="hidden" name="token" value="<%= token %>">` and a "Continue to the drop →" button. `magicExpired.ejs`: a short message and a note to request a new link (it cannot self-rebuild the drop link, so just explain).

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/magic-verify.test.ts` → PASS.

**Step 5: Commit**

```bash
git add src/routes/auth/magic.ts src/views/magicConfirm.ejs src/views/magicExpired.ejs tests/integration/magic-verify.test.ts
git commit -m "feat(auth): prefetch-safe magic-link verify (GET confirm, POST consume)"
```

---

## Task 12: Wire routes + token sweep

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/scheduler.ts` (or `gc.ts`) for token cleanup
- Test: `tests/integration/magic-sweep.test.ts`

**Step 1: Wire the route**

In `src/index.ts`, import `magicRoutes` and register it inside `onAppHost(...)` after `dropBootstrapRoute`:

```ts
import { magicRoutes } from './routes/auth/magic';
// ...
await s.register(magicRoutes);
```

**Step 2: Sweep — failing test**

`tests/integration/magic-sweep.test.ts`: insert one expired and one live token, call the sweep, assert only the live one remains. Read `tests/unit/scheduler.test.ts` / `src/services/scheduler.ts` first to match how the orphan sweep is structured and invoked.

**Step 3: Implement**

Have the existing periodic sweep (started by `startOrphanSweep()` in `src/index.ts`) also call `deleteExpiredMagicTokens()` from Task 5. If the scheduler runs a single sweep function, add the call there; keep it best-effort (catch + log), matching the orphan sweep's posture.

**Step 4: Run to verify pass**

Run: `pnpm test -- tests/integration/magic-sweep.test.ts` → PASS.
Run the full suite: `pnpm test` → all green. `pnpm typecheck` → clean. `pnpm lint` → clean.

**Step 5: Commit**

```bash
git add src/index.ts src/services/scheduler.ts tests/integration/magic-sweep.test.ts
git commit -m "feat(auth): wire magic-link routes and sweep expired tokens"
```

---

## Task 13: E2E happy path (inject-based)

**Files:**
- Create: `tests/e2e/magic-link.spec.ts`

The existing e2e specs (`tests/e2e/drop.spec.ts`) are **not** browser-driven — Playwright is used as a runner and requests go through `app.inject` against an in-process server built with `buildServer()`. The Playwright config has no `webServer`. Model the new spec on `drop.spec.ts`: set env, `setupTestDatabase()`, `resetBucket()`, build the server, register the needed routes, and drive the flow with `inject`, following cookies and the handoff redirect by hand. Capture the link from the in-process `ConsoleMailer` via `getMailer()`.

**Step 1: Write the spec** (`tests/e2e/magic-link.spec.ts`)

Outline (fill in cookie-threading from `drop.spec.ts`):

```ts
// ABOUTME: End-to-end magic-link viewer flow over app.inject: request → confirm → verify → serve.
import { test, expect } from '@playwright/test';
// ...same env preamble as drop.spec.ts...

test('non-member views a drop via an emailed magic link', async () => {
  // setup db + bucket; create owner 'alice'. Seed the drop+version DIRECTLY (no upload
  // route, no owner session): createDropAndVersion('alice.id', 'foo', { r2Prefix:
  // 'drops/<uuid>/', byteSize, fileCount: 1 }), then setViewMode(dropId, 'emails'),
  // addViewer(dropId, 'guest@outside.test'), and putObject(`${r2Prefix}index.html`,
  // Buffer.from('<h1>Hello from fixture</h1>'), 'text/html'). This avoids threading an
  // owner upload session/CSRF — the e2e under test is the viewer path, not upload.

  // build server, register: dropBootstrapRoute, magicRoutes (app host, with registerCsrf),
  // bootstrapRoute + dropServeRoute (drop host).

  const dropHostUrl = '/'; // served on host 'alice--foo.content.localtest.me'

  // 1) GET interstitial to obtain csrf cookies
  const page = await app.inject({ method: 'GET',
    url: '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2F',
    headers: { host: 'drops.localtest.me' } });
  // parse drops_csrf + csrf_anon from page.headers['set-cookie'], grab _csrf value

  // 2) POST request a link  (form posts MUST set the urlencoded content-type)
  await app.inject({ method: 'POST', url: '/auth/magic/request',
    headers: { host: 'drops.localtest.me', origin: 'http://drops.localtest.me:3000',
               'content-type': 'application/x-www-form-urlencoded',
               cookie: `${csrfAnonCookie}; drops_csrf=${csrf}` },
    payload: `host=alice--foo.content.localtest.me&next=%2F&email=guest@outside.test&_csrf=${csrf}` });

  // 3) read the link from the in-process mailer
  const { getMailer } = await import('../../src/lib/mail');
  const sent = (getMailer() as { sent: { text: string }[] }).sent;
  const token = new URL(sent.at(-1)!.text.match(/https?:\S+/)![0]).searchParams.get('token')!;

  // 4) GET confirm (non-consuming), then 5) POST verify
  await app.inject({ method: 'GET', url: `/auth/magic/verify?token=${token}`,
    headers: { host: 'drops.localtest.me' } });
  const verify = await app.inject({ method: 'POST', url: '/auth/magic/verify',
    headers: { host: 'drops.localtest.me', origin: 'http://drops.localtest.me:3000',
               'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${token}` });
  expect(verify.statusCode).toBe(302);          // → drop-host /auth/bootstrap?token=…

  // 6) follow the handoff to the drop-host bootstrap (sets drops_drop_session)
  const bootUrl = new URL(verify.headers.location as string);
  const boot = await app.inject({ method: 'GET', url: bootUrl.pathname + bootUrl.search,
    headers: { host: bootUrl.hostname } });
  expect(boot.statusCode).toBe(302);
  const dropCookie = /* drops_drop_session from boot.headers['set-cookie'] */;

  // 7) serve content with the drop-session cookie
  const content = await app.inject({ method: 'GET', url: '/',
    headers: { host: 'alice--foo.content.localtest.me', cookie: dropCookie } });
  expect(content.statusCode).toBe(200);
  expect(content.body).toContain('Hello from fixture');
  await app.close();
});
```

**Step 2: Run**

Run: `pnpm test:e2e`
Expected: PASS (full real flow through inject; no mocked auth).

**Step 3: Commit**

```bash
git add tests/e2e/magic-link.spec.ts
git commit -m "test(e2e): magic-link viewer happy path"
```

---

## Final verification

Before declaring done (see superpowers:verification-before-completion):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

All four must pass with pristine output. Then update `README.md` / deployment docs to mention the new env vars (`MAIL_PROVIDER`, `MAIL_FROM`, `RESEND_API_KEY`) and that magic-link viewing is dormant until `MAIL_PROVIDER=resend` is set. Commit that doc change.
