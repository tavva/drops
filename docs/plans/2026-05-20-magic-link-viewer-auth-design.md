# Magic-link viewer auth — design

## Problem

Today every path to viewing a drop requires a Google sign-in. `requireDropSession`
(`src/middleware/auth.ts`) runs on every drop request and demands a drop-session
cookie; when none exists it bounces to the app-host `/auth/drop-bootstrap`, which
redirects to `/auth/login` → Google OAuth whenever there is no app session. Even
`viewMode = 'public'` is "any signed-in Google user", not "anyone with the link".
The `drop_viewers` allowlist grants permission *after* a Google login; it is not a
credential. So a collaborator without a Google account cannot view a drop at all.

We want to share drops with specific people who lack Google accounts, while still
knowing who viewed. The chosen mechanism is an email magic link: the owner adds an
email to a drop's viewers, and that person authenticates by clicking a one-time
link sent to that address.

## Why this fits the existing model

Identity in this codebase is the email. `users.email` is unique and there is no
Google `sub` column; a user row carries only `kind ∈ {member, viewer}`. A
magic-link viewer is therefore an ordinary `users` row with `kind = 'viewer'` and
no Google linkage. Everything downstream — session creation, `getSessionUser`,
`canView`, the host-bound handoff — works unchanged.

The Google callback already contains the exact tail we need. For a viewer,
`completeLogin` (`src/routes/auth/callback.ts`) does **not** set an app cookie; it
reads the drop target from `next`, mints a 60-second handoff token, and bounces to
the drop-host `/auth/bootstrap`. Magic-link completion is the viewer branch of that
callback with Google swapped for a clicked token. It reuses
`findByEmail` / `createViewerUser`.

`completeLogin` is currently a private function inside `callback.ts`. We extract its
viewer path to a shared, exported `completeViewerLogin(reply, userId, next)` in a new
`src/routes/auth/complete.ts`, and have the Google callback's viewer branch call the
same helper. The helper creates a session and runs the handoff-and-bounce tail; it
never sets an app cookie and never touches the user row, so passing a member's user
id yields drop-content access only. It preserves the current viewer fallback: when
`dropTargetFromNext(next)` is null it redirects to `/auth/goodbye`, exactly as the
callback does today, so extracting it does not change the Google path. This keeps one
code path for both entry points rather than duplicating the tail.

## Scope

The magic link authenticates an *email*, not a drop. `canView` continues to gate
each drop per request, exactly as it does for a Google viewer session. One link
means "you are bob@work.com"; bob then sees whatever bob is allowed to see. This
avoids a parallel per-drop-permission concept (YAGNI).

The link never changes a user's stored `kind`. If the email belongs to an existing
member, the magic-link session still grants only drop-content access — no app
cookie, no dashboard — because the completion always runs the viewer tail. So a
member who clicks a magic link views the drop; they do not gain dashboard access
through it.

Out of scope: numeric codes (link only — the recipient followed a browser link, so
a clickable link is the simplest path; a code helps only cross-device and can be
added later), SMTP delivery (interface supports it; we ship Resend only), and any
admin UI beyond the existing viewer-add flow.

## Flow

1. A logged-out person follows a shared drop link. `requireDropSession` bounces to
   app-host `/auth/drop-bootstrap?host=…&next=…`; there is no app session.
2. Instead of redirecting to Google, the route renders an interstitial offering two
   choices: *Sign in with Google* (the current redirect, unchanged) or *Email me a
   sign-in link*. Both carry `host` and `next` forward.
3. The person submits their email to `POST /auth/magic/request` (origin-checked
   plus anonymous CSRF token, `tightAuthLimit` — see *CSRF* below). The route
   normalises the email, rejects it unless `isLikelyEmail` (`src/lib/email.ts`)
   passes, resolves the drop from `host`, and checks eligibility with
   `canViewByEmail(email, drop)` (see *Eligibility*). It **always** re-renders the
   interstitial with the same status and the same "check your email" notice — whether
   the email was malformed, ineligible, or eligible. The only thing that varies is the
   per-render CSRF token, so responses are not byte-identical; the observable invariant
   is that an ineligible or malformed request writes no token row and sends nothing. If
   eligible, and only when no unconsumed, unexpired token already exists for that
   `(email, drop_id)` pair, it stores a single-use token and sends the link (see
   *Abuse throttling*).
4. The emailed link is `GET /auth/magic/verify?token=…`. The GET **does not consume**
   the token; it renders a confirmation page (`magicConfirm.ejs`) with a button that
   POSTs the token back. This survives email-client and scanner prefetch, which
   issue GETs.
5. `POST /auth/magic/verify` (origin-checked, token-as-capability, `tightAuthLimit`)
   consumes the token atomically, find-or-creates the user for the email (creating a
   `kind = 'viewer'` row only when absent; never altering an existing row), then
   calls `completeViewerLogin(reply, userId, next)`.
6. `completeViewerLogin` mints the handoff and bounces to the drop-host
   `/auth/bootstrap`, which sets the drop-session cookie and serves the content —
   identical to the Google viewer tail.

## Data model

A new table mirrors the `pending_logins` shape:

```
magic_link_tokens(
  id          text primary key,   -- the secret: >=32 random bytes, base64url
  email       text not null,      -- normalised (lowercase + NFC), as drop_viewers
  drop_id     uuid not null references drops(id) on delete cascade,
  next        text not null,      -- the drop target URL to resume
  consumed_at timestamptz,        -- null until clicked; single-use
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
)
```

- **The token is the row id**, a high-entropy random string, following the
  `sessions.id` pattern. The email link carries only this opaque token.
- **Single-use, race-safe.** Verify runs one atomic statement:
  `UPDATE magic_link_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS
  NULL AND expires_at > now() RETURNING email, next`. Zero rows means spent,
  expired, or invalid, and the route renders a neutral "link expired" page. The
  atomic update closes the double-click and replay races.
- **TTL: 15 minutes.** Long enough to switch to an email client, short enough to
  limit exposure.
- **`next` validated on the way in**, via the existing `dropTargetFromNext` /
  `allowedNext` helpers, so a token can only ever resume to a legitimate drop
  target. It is not re-trusted on the way out.
- **Cleanup.** The existing orphan sweep in `src/index.ts` gains a cheap `DELETE`
  of expired or consumed rows.

## Mailer

A thin abstraction with one production backend and one dev/test backend, selected
by config:

```ts
// src/lib/mail/types.ts
export interface Mailer {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
}
```

- **`ResendMailer`** (`src/lib/mail/resend.ts`) POSTs to Resend's `/emails`
  endpoint with `RESEND_API_KEY` using plain `fetch`, no SDK. It throws on non-2xx
  so the request route can log the failure while still returning the neutral
  success response.
- **`ConsoleMailer`** (`src/lib/mail/console.ts`) records each message in an
  in-memory `sent[]` array and writes nothing to stdout, so integration and e2e
  tests can capture the link without a real provider and without polluting test
  output. The request route logs a send via `req.log` (silent under test).
- **`getMailer()`** picks the backend from config and memoises it, following the
  lazy `config` proxy pattern.

New config keys in `src/config.ts`:

```
MAIL_PROVIDER   = z.enum(['resend','console']).default('console')
MAIL_FROM       = z.string().email().optional()   // required when provider==='resend'
RESEND_API_KEY  = z.string().optional()            // required when provider==='resend'
```

A `loadConfig` refinement requires `MAIL_FROM` and `RESEND_API_KEY` when
`MAIL_PROVIDER === 'resend'`, failing at boot rather than at first send — matching
the existing `APP_ORIGIN ≠ CONTENT_ORIGIN` cross-check. The default `console` keeps
existing instances booting; magic-link stays dormant until an operator sets
`MAIL_PROVIDER=resend`.

## Routes and entry point

The one behaviour change to an existing flow is in `dropBootstrap.ts`. Today, on no
app session, it redirects straight to Google. It will instead render
`dropSignin.ejs`: the requested drop, a *Sign in with Google* button (the current
target, unchanged), and an *Email me a sign-in link* form. The dashboard login path
(`/auth/login` from `requireAppSession`) is untouched, so members signing into the
dashboard still go straight to Google.

Three new app-host routes, registered in `src/index.ts`:

- **`POST /auth/magic/request`** — origin-checked plus anonymous CSRF, `tightAuthLimit`.
  Normalises the email, resolves the drop from `host`, checks `canViewByEmail`. If
  eligible, creates a token and sends the link. **Always** re-renders `dropSignin.ejs`
  with the same status and notice; the only thing that varies between an eligible and
  an ineligible request is the per-render CSRF token, never anything revealing
  eligibility. The mail send happens after the response decision, so a provider error
  never changes what the user sees and is only logged. The observable invariant is
  zero token rows and zero sends for an ineligible or malformed email. No enumeration.
- **`GET /auth/magic/verify?token=…`** — `tightAuthLimit`, `skipCsrf`. Renders
  `magicConfirm.ejs` with a POST button. It **does not consume** the token, so
  email-client and scanner prefetch (which issue GETs) cannot burn it. A malformed or
  obviously absent token still renders `magicExpired.ejs`.
- **`POST /auth/magic/verify`** — origin-checked, `tightAuthLimit`, `skipCsrf`. The
  high-entropy token in the body is itself the capability. Consumes the token
  atomically; on success find-or-creates the user and calls `completeViewerLogin`; on
  failure renders `magicExpired.ejs` with a link back to re-request.

### CSRF for the logged-out interstitial

`contextId` in `src/middleware/csrf.ts` resolves only an app session or a pending
login; a logged-out viewer has neither, so the existing CSRF would return
`no_csrf_context`. We add an explicit anonymous context: when `GET /auth/drop-bootstrap`
renders the interstitial with no session, it sets a signed, http-only `csrf_anon`
cookie holding a random id, and `contextId` falls back to that id. The double-submit
token then binds to it exactly like a session-bound token. The existing exact-origin
check applies to every state-changing POST regardless. `POST /auth/magic/verify`
relies on the origin check plus the unguessable token as its capability and so is
marked `skipCsrf`, the same posture used for `/auth/callback` and `/auth/bootstrap`.

### Eligibility

Request-time eligibility must mirror the final `canView` gate (`src/services/permissions.ts`),
or we would email links that later 403, or reject viewers of a `public` drop. We add
`canViewByEmail(email, drop)` that reproduces `canView` without a `user.id`, resolving
the owner by email:

| `viewMode` | eligible when |
| --- | --- |
| owner (any mode) | the email resolves to `drop.ownerId` |
| `public` | always |
| `authed` | `isMemberEmail(email)` |
| `emails` | `isViewerAllowed(drop.id, email)` |

`canView` is refactored to delegate to `canViewByEmail` so the two cannot drift.

### Abuse throttling

`tightAuthLimit` is a small per-IP, per-route cap. It is not enough on its own once
`public` drops accept link requests for any valid email, because an attacker could
email-bomb a victim from many IPs. We add a per-recipient cooldown that lives in the
token table itself: a request only sends when no unconsumed, unexpired token already
exists for the `(email, drop_id)` pair; otherwise it silently reuses the outstanding
token and shows the same neutral notice, sending nothing. The key is `drop_id`, not
`next`, so an attacker cannot bypass the cooldown by varying the path or query on the
same drop; the token still stores the original `next` for resume. This caps mail to
one message per recipient per drop per TTL window while staying enumeration-safe —
the status and notice are the same whether or not a send occurred (only the per-render
CSRF token differs), and no token row or send betrays the outcome.

The check-then-insert must be atomic so two concurrent requests cannot both decide to
send. Do the select-then-insert inside a single transaction with the row locked
(`SELECT … FOR UPDATE` on the drop, or a transaction-level advisory lock keyed by a
hash of `(email, drop_id)`); expiry stays a runtime predicate in that query rather
than an index predicate, since `now()` is not immutable and cannot live in a partial
unique index.

## Error handling

| Condition | Response |
| --- | --- |
| Email malformed (`isLikelyEmail` false) | Identical neutral notice; no token, no send |
| Email not eligible (`canViewByEmail` false) | Identical neutral "check your email" notice; no token, no send |
| Outstanding unexpired token for `(email, drop_id)` | Identical neutral notice; reuse it, no new send |
| Resend returns non-2xx | Logged; user still sees the neutral notice |
| GET prefetch of the verify link | Confirmation page only; token not consumed |
| Token expired / consumed / unknown (on POST verify) | `magicExpired.ejs`, link to re-request |
| `next` not a legitimate drop target | Rejected at request time; no token issued |
| Rate limit exceeded on request or verify | 429 from `tightAuthLimit` |
| Boot with `MAIL_PROVIDER=resend` and missing keys | `loadConfig` throws at startup |

## Testing

**Unit.** Token service: issue → consume once (second consume fails); expired and
unknown tokens fail. `canViewByEmail` mirrors `canView` across owner, `public`,
`authed`, and `emails` drops, for member, listed-viewer, and unknown emails. Email
normalisation matches `drop_viewers` (lowercase + NFC), so a link issued to
`Bob@Work.com` authenticates against `bob@work.com`. `ConsoleMailer` captures the
message. Config refinement throws when `MAIL_PROVIDER=resend` lacks `MAIL_FROM` or
`RESEND_API_KEY`. `next` validation rejects a non-drop target at request time.

**Integration** (real Postgres and MinIO, `ConsoleMailer`, single-worker series as
the harness requires):
- `POST /auth/magic/request` for an allowlisted viewer returns 200 with the neutral
  notice, writes exactly one token row, and sends exactly one message.
- **Enumeration guard:** requests for a non-allowlisted email and for a malformed
  email each return the same status and notice as an eligible request (differing only
  in the per-render CSRF token), and crucially write zero token rows and send nothing.
- **Send throttling:** a second request for the same email and drop within the TTL —
  including with a *different* valid `next` path on that drop — returns the neutral
  notice, adds no token row, and sends nothing.
- `GET /auth/magic/verify` with the captured token renders the confirmation page and
  leaves the token unconsumed (token row's `consumed_at` stays null; a following POST
  still succeeds) — the prefetch guard.
- `POST /auth/magic/verify` with the captured token creates a `kind = 'viewer'` user
  and 302s to the drop-host `/auth/bootstrap` with a handoff token; the redirect shape
  matches the Google viewer tail.
- A member's email used via magic link gets a content session without an app cookie,
  and the existing member row's `kind` is unchanged.
- Replay: a second POST verify with the same token renders `magicExpired.ejs` and
  creates no session.
- Rate limiting: `POST /auth/magic/request` returns 429 past the `tightAuthLimit`
  threshold.
- Test output stays pristine: a deliberately triggered provider failure is captured
  and asserted, not left logging errors.

**E2E** (Playwright): extend the happy path. Visit a drop logged out, choose *Email
me a link*, read the link from the `ConsoleMailer` capture, follow it, click the
confirmation button, and assert the drop content renders. Real flow, no mocked auth.
