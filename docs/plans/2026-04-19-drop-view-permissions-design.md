# Drop view permissions — design

## Goal

Give drop owners control over who can view each drop. Three exclusive modes per drop:

- `authed` (default): any *member* — anyone who passed the global sign-in gate — can view. Current behaviour.
- `public`: any Google account can sign in and view this drop.
- `emails`: only addresses on this drop's viewer list can view. The owner always can.

The owner can always view their own drop, regardless of mode.

## Non-goals

- Per-version permissions
- Expiring viewer entries
- Groups or teams
- Unauthenticated ("no login") public drops — "public" still requires a Google sign-in
- Invite links, pending invitations, or email notifications
- Admin UI for the global allowlist — still managed by inserting into `allowed_emails`

## Member vs viewer users

The current OAuth callback admits a Google login iff the email matches `ALLOWED_DOMAIN` or sits in `allowed_emails`. Admitted users get a session and full app-host access (`/app`, can create drops, see the "All drops" feed, own drops).

This design widens admission. That means we need two tiers so that an outsider admitted only because of a drop permission does *not* get app-host access, a username, or visibility of other drops.

**Two user kinds, stored on `users`:**

- `member` — passes the global allowlist. Has a username (via `choose-username`). Can access `/app`, own drops, and view any `authed` drop.
- `viewer` — admitted only because of a drop permission. Has no username. Can only hit content origin. Cannot access `/app`.

`kind` is set at user creation and refreshed on every login based on current allowlist state (see "Promotion / demotion" below).

### Username column

`users.username` becomes nullable and the unique index becomes partial (`WHERE username IS NOT NULL`). Newly-created viewers have `username = NULL`. Members demoted to viewers keep their existing username — harmless, since the username only matters on app host and viewers can't reach it.

### Flow

Callback computes `isMemberEmail(email)`. The branch then depends on *existing user* plus the *new* desired kind.

**New user, member-eligible:** today's path — create `pending_login`, redirect to `/auth/choose-username`. Username saved → create user with `kind='member'` + session + handoff.

**New user, viewer-only-eligible:** create the user row immediately with `kind='viewer'`, `username=NULL` + session (content-only — see cookie rules below) + handoff.

**Existing user — already a member, still member-eligible:** session + handoff as today. No kind change.

**Existing user — currently a viewer, now member-eligible (promotion):** update `users.kind = 'member'` in place (but leave `username` null for now). Issue an app session. Redirect to `/auth/choose-username?next=…`. The `choose-username` route gains a second mode: if there is a valid app session and the user's `username IS NULL`, render the same form and POST updates the existing user's username rather than consuming a `pending_login`.

**Existing user — currently a member, no longer member-eligible but viewer-eligible (demotion):** update `users.kind = 'viewer'` in place. Keep the existing `username` (harmless; enforced-unique but unused). Issue only a content session. Handoff.

**Existing user — currently a viewer, still viewer-eligible:** unchanged kind, session + handoff.

**Not member-eligible, not viewer-eligible:** 403 `not_allowed` (unchanged).

`canSignInAsViewer(email)` is true iff:

1. at least one drop has `view_mode = 'public'`, or
2. email appears in `drop_viewers` on at least one drop, or
3. the email owns at least one drop (keeps demoted owners able to sign in and view their own drops, since `canView` always admits the owner).

### Two changes to `choose-username`

1. **New "update existing user" mode.** `GET /auth/choose-username` also accepts a caller with a valid app session whose `users.username IS NULL`. POST in that mode updates the existing row (setting `username`) instead of consuming a `pending_login`. The CSRF token in this mode is bound to the session id (same pattern used elsewhere) instead of the pending-login id.
2. The "new user" mode unchanged in behaviour; it now explicitly sets `kind='member'` on insert.

A small preHandler on member-only app routes (dashboard, new-drop, edit-drop, etc.) bumps any signed-in member with `username IS NULL` to `/auth/choose-username` before serving the route. This handles the in-between state cleanly if the user dodges the callback redirect.

### Cookies: members get both, viewers get content-only

Today the callback sets `APP_SESSION_COOKIE` before handing off to content bootstrap which sets `CONTENT_SESSION_COOKIE`. Change: **viewers are issued the content session cookie only**. They have no app cookie at all.

A browser can still hold a stale `APP_SESSION_COOKIE` from a prior member login (e.g. a member who was just demoted to viewer, or a cookie older than any allowlist change). The "no app cookie for viewers" rule therefore needs defence in depth in two places:

1. **On demotion (callback, member → viewer transition):** actively clear the app cookie via `reply.clearCookie(APP_SESSION_COOKIE, …)` and terminate the user's existing app-host sessions. Since sessions aren't tagged as app- or content-host and we can't cleanly revoke only the app side, the simplest correct step is to call `deleteSession(existingAppSid)` if the request carried an app cookie for this user, then issue a fresh content-only session. The fresh content session also displaces the old app session in the browser.
2. **In `requireAppSession`:** after loading the user, reject `user.kind !== 'member'`. Clear the app cookie and redirect to `/auth/login`. This catches any pre-demotion session that survived step 1 (e.g. session active in another browser) and any future drift between cookie issuance policy and the user row.

### Avoiding post-callback loops for viewers

If a viewer's resolved `next` points at the app origin (e.g. they typed the app URL manually before signing in), handing them off to an app-origin URL creates a redirect loop (app requires app session → no session → login → callback → viewer, repeat). Callback therefore overrides `next` to `CONTENT_ORIGIN/` whenever the admitted user is a viewer and `next` is on app origin (or missing).

### Content-origin root route

Today `CONTENT_ORIGIN/` 404s — no route is registered. Add a minimal `GET /` on content origin, behind `requireContentSession`, that renders a one-line "Signed in as <email>" page with a sign-out button. Purely a landing target for viewers who end up there; not a discovery surface.

### Content-host gate

`requireContentSession` is unchanged structurally; the per-drop `canView` check inside the handler enforces the mode.

## Data model

Single Drizzle migration:

```sql
-- user kinds
ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'member'
  CHECK (kind IN ('member','viewer'));

-- username nullable (was NOT NULL UNIQUE)
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
DROP INDEX users_username_key;  -- or whatever Drizzle named it
CREATE UNIQUE INDEX users_username_unique ON users(username) WHERE username IS NOT NULL;

-- per-drop mode
ALTER TABLE drops ADD COLUMN view_mode text NOT NULL DEFAULT 'authed'
  CHECK (view_mode IN ('authed','public','emails'));

-- viewer list
CREATE TABLE drop_viewers (
  drop_id  uuid        NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  email    text        NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (drop_id, email)
);
CREATE INDEX drop_viewers_email_idx ON drop_viewers(email);
```

No data backfill needed. Existing users default to `member` with their existing username; existing drops default to `authed`, matching today's behaviour.

Emails are stored lowercase + NFC-trimmed. All comparisons go through the same normaliser.

Switching modes preserves the viewer list. Rows go away only when the owner explicitly removes them or the drop is deleted.

## Authorisation

Two gates — sign-in and view-time — defined as explicit pure functions.

### Sign-in gate (OAuth callback)

```
isMemberEmail(email):
  domain matches ALLOWED_DOMAIN
  OR email in allowed_emails

canSignInAsViewer(email):
  EXISTS drop with view_mode = 'public'
  OR EXISTS drop_viewers row with email
  OR EXISTS drop owned by a user with this email

admit(email):
  if isMemberEmail(email): allow as member
  elif canSignInAsViewer(email): allow as viewer
  else: 403 not_allowed
```

### View-time gate (content serve)

```
canView(user, drop):
  if user.id == drop.ownerId: allow
  switch drop.view_mode:
    'public': allow
    'authed': allow iff isMemberEmail(user.email)
    'emails': allow iff drop_viewers contains (drop.id, lower(user.email))
```

Failure returns 404 — same as "drop does not exist". No leaking of existence or mode.

The `authed` branch re-checks `isMemberEmail` because viewers now have sessions too; their sessions must not bypass the allowlist on member-only drops.

Revocation is immediate: every request re-checks, so removing an email from a viewer list takes effect on the viewer's next navigation. No session invalidation required.

## App-host surfaces

### Dashboard "Your drops"

Unchanged — scoped to `ownerId = user.id`.

### Dashboard "All drops"

Today this is an unfiltered feed. With viewer lists in play, unrestricted display leaks drop names and URLs to members who aren't entitled to them.

Change: `listAllVisible(user)` returns drops where `canView(user, drop)` is true, i.e.

- `view_mode = 'public'`, OR
- `view_mode = 'authed'` and user is a member (always true here — only members reach `/app`), OR
- `view_mode = 'emails'` and the user's email is in that drop's `drop_viewers`, OR
- `owner_id = user.id`

Implemented as a single SQL query using a `LEFT JOIN drop_viewers ON drop_id = drops.id AND email = $userEmail` with a `WHERE` that encodes the rule.

### Edit-drop page

New "Who can view" section (only the owner sees this page; ownership is enforced via `findByOwnerAndName(user.id, name)`):

- Radio group (`authed` / `public` / `emails`) posting to `POST /app/drops/:name/permissions`
- Viewer list block, server-rendered only when `mode = 'emails'`:
  - Bulleted list of existing emails; each item has a small remove button posting to `POST /app/drops/:name/viewers/:email/delete`
  - Input + "Add" button posting to `POST /app/drops/:name/viewers`

The viewer-list block is server-rendered on mode-flip (form submit + full reload). No client-side JS toggling.

### Inline validation on add

Matching the existing pattern in `chooseUsername.ts`: on invalid input, re-render the edit view with `400` and an `error` local, displayed inline near the viewer input. Email validation applies:

- lowercase + NFC-trim
- simple `x@y.z` regex (same one used in the add flow)
- duplicate add → `ON CONFLICT DO NOTHING`, no error surfaced (treat as success — the target state is "this email is on the list")
- malformed → re-render with `error`

Removing the last email while in `emails` mode is allowed. The drop just becomes unviewable by anyone but the owner — a valid state.

### Dashboard badges

Small badge next to each drop in "Your drops": `public` for public drops, `list` for `emails` drops, nothing for `authed`. One extra field on `DropSummary` pulled from the existing query.

### Owner-only mutation responses

For consistency with existing owner-scoped mutation routes (e.g. `deleteDrop`), all three new routes return **404** — not 403 — when the drop isn't found *or* the caller isn't the owner. This preserves the no-enumeration posture already in the codebase.

### New routes (all `requireAppSession`, CSRF-protected, `APP_ORIGIN`, member-only)

- `POST /app/drops/:name/permissions` — body `{ mode }`
- `POST /app/drops/:name/viewers` — body `{ email }`
- `POST /app/drops/:name/viewers/:email/delete`

Ownership check: `findByOwnerAndName(req.user.id, name)` → if null, 404.

## Tests

### Unit (`tests/unit/`)

- `canView` — matrix across `{owner, member, viewer-listed, viewer-not-listed, stranger}` × `{authed, public, emails}`
- `isMemberEmail` and `canSignInAsViewer` — covers domain allowlist, `allowed_emails`, `drop_viewers`, public drop existence
- email normalisation (lowercase + NFC trim + regex)
- `drop_viewers` service: add/remove/list, idempotent add, cascade on drop delete

### Integration (`tests/integration/`)

- Outsider on a drop's viewer list: signs in → content session issued, no app session cookie set → can view that drop → 404s on other drops → hitting `/app` redirects to `/auth/login` (no app session)
- Any Google email can sign in when any public drop exists, but cannot reach `/app` and 404s on `authed`-mode drops
- Member whose email isn't on an `emails`-mode drop: 404s on that drop; doesn't see it in "All drops"
- Owner can view their own drop in any mode, including `emails` with themselves not listed
- Viewer promotion: viewer later added to `allowed_emails` → next login flips `users.kind = 'member'`, callback redirects to `/auth/choose-username`, POST updates the existing user's username, subsequent app requests succeed
- Viewer → content root landing: fresh viewer signing in with `next` pointing at the app origin is redirected to `CONTENT_ORIGIN/` which renders the minimal signed-in page
- Member demotion: member removed from `allowed_emails` but still on at least one drop's viewer list → next login flips `kind = 'viewer'`, no app cookie issued, stale app session for that user is terminated
- Stale app cookie defence in depth: craft a browser with a valid `APP_SESSION_COOKIE` whose user was flipped to `kind = 'viewer'` out-of-band — `requireAppSession` clears the cookie and redirects to `/auth/login`
- New routes: happy paths for permissions change, viewer add, viewer remove; 404 when posting as a non-owner
- Revocation: remove email → next request returns 404

### E2E (Playwright)

One happy-path scenario: owner switches a drop to `emails`, adds a viewer, the viewer signs in from a fresh browser, views the drop, owner removes them, viewer now gets 404.

## Delivery order

1. Schema + Drizzle migration (including users changes)
2. Email normalisation helper
3. `drop_viewers` service; `isMemberEmail`, `canSignInAsViewer`, `canView` functions
4. OAuth callback update: member vs viewer branching, promotion/demotion handling, cookie-scope rules
5. `choose-username` update-existing-user mode; member-with-null-username guard on app routes
6. Minimal content-origin `/` landing route
7. "All drops" filter query
8. Content-serve `canView` integration
9. App routes + edit-drop view updates + dashboard badges
10. Tests (unit, integration, one e2e)
