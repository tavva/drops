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
`findByEmail` / `createViewerUser` and calls `completeLogin(reply, userId, 'viewer',
next)` untouched.

## Scope

The magic link authenticates an *email*, not a drop. `canView` continues to gate
each drop per request, exactly as it does for a Google viewer session. One link
means "you are bob@work.com"; bob then sees whatever bob is allowed to see. This
avoids a parallel per-drop-permission concept (YAGNI).

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
3. The person submits their email to `POST /auth/magic/request` (CSRF-checked,
   `tightAuthLimit`). The route normalises the email, resolves the drop from `host`,
   and checks eligibility (`isMemberEmail` OR `isViewerAllowed(dropId, email)`). It
   **always** re-renders the interstitial with an identical "check your email"
   notice — same status, same body — whether or not the email was eligible. If
   eligible, it stores a single-use token and sends the link.
4. The emailed link is `GET /auth/magic/verify?token=…`. The route consumes the
   token atomically, find-or-creates a `kind = 'viewer'` user for the email, then
   calls `completeLogin(reply, userId, 'viewer', next)`.
5. `completeLogin` mints the handoff and bounces to the drop-host `/auth/bootstrap`,
   which sets the drop-session cookie and serves the content — identical to the
   Google viewer tail.

## Data model

A new table mirrors the `pending_logins` shape:

```
magic_link_tokens(
  id          text primary key,   -- the secret: >=32 random bytes, base64url
  email       text not null,      -- normalised (lowercase + NFC), as drop_viewers
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
- **`ConsoleMailer`** (`src/lib/mail/console.ts`) logs the message via `pino` at
  info. Used in dev and tests; it lets integration and e2e tests capture the link
  without a real provider.
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

Two new app-host routes, registered in `src/index.ts`:

- **`POST /auth/magic/request`** — CSRF-checked, `tightAuthLimit`. Normalises the
  email, resolves the drop from `host`, checks eligibility. If eligible, creates a
  token and sends the link. **Always** re-renders `dropSignin.ejs` with an identical
  notice; the mail send happens after the response decision, so a provider error
  never changes what the user sees and is only logged. No enumeration.
- **`GET /auth/magic/verify?token=…`** — `tightAuthLimit`, `skipCsrf` (a GET from an
  email client). Consumes the token atomically; on success find-or-creates the
  viewer and calls `completeLogin(reply, userId, 'viewer', next)`; on failure
  renders `magicExpired.ejs` with a link back to re-request.

The interstitial needs a CSRF token minted before any session exists. The codebase
already does this for pre-signup, binding CSRF to the pending-login id
(`src/lib/csrf.ts`); we reuse that mechanism rather than invent a new one.

## Error handling

| Condition | Response |
| --- | --- |
| Email not eligible | Identical neutral "check your email" notice; no token, no send |
| Resend returns non-2xx | Logged; user still sees the neutral notice |
| Token expired / consumed / unknown | `magicExpired.ejs`, link to re-request |
| `next` not a legitimate drop target | Rejected at request time; no token issued |
| Rate limit exceeded on request | 429 from `tightAuthLimit` |
| Boot with `MAIL_PROVIDER=resend` and missing keys | `loadConfig` throws at startup |

## Testing

**Unit.** Token service: issue → verify consumes once (second verify fails);
expired and unknown tokens fail. Email normalisation matches `drop_viewers`
(lowercase + NFC), so a link issued to `Bob@Work.com` authenticates against
`bob@work.com`. `ConsoleMailer` captures the message. Config refinement throws when
`MAIL_PROVIDER=resend` lacks `MAIL_FROM` or `RESEND_API_KEY`. `next` validation
rejects a non-drop target at request time.

**Integration** (real Postgres and MinIO, `ConsoleMailer`, single-worker series as
the harness requires):
- `POST /auth/magic/request` for an allowlisted viewer returns 200 with the neutral
  notice, writes exactly one token row, and sends exactly one message.
- **Enumeration guard:** a request for a non-allowlisted email returns a
  byte-identical response and status, writes zero token rows, and sends nothing.
- `GET /auth/magic/verify` with the captured token creates a `kind = 'viewer'` user
  and 302s to the drop-host `/auth/bootstrap` with a handoff token; the redirect
  shape matches the Google viewer tail.
- Replay: a second verify with the same token renders `magicExpired.ejs` and creates
  no session.
- Rate limiting: `POST /auth/magic/request` returns 429 past the `tightAuthLimit`
  threshold.
- Test output stays pristine: a deliberately triggered provider failure is captured
  and asserted, not left logging errors.

**E2E** (Playwright): extend the happy path. Visit a drop logged out, choose *Email
me a link*, read the link from the `ConsoleMailer` capture, follow it, and assert
the drop content renders. Real flow, no mocked auth.
