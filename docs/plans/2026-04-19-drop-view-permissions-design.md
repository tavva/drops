# Drop view permissions — design

## Goal

Give drop owners control over who can view each drop. Three exclusive modes per drop:

- `authed` (default): any user who passed the global sign-in gate — current behaviour
- `public`: anyone who can sign in with Google
- `emails`: only addresses on this drop's viewer list (plus the owner)

The owner can always view their own drop, regardless of mode.

## Non-goals

- Per-version permissions
- Expiring viewer entries
- Groups or teams
- Unauthenticated ("no login") public drops — "public" still requires a Google sign-in
- Invite links, pending invitations, or email notifications
- Admin UI for the global allowlist — still managed by inserting into `allowed_emails`

## Data model

Two additions, both in one Drizzle migration. No data backfill: existing drops default to `authed`, matching today's behaviour.

```sql
ALTER TABLE drops ADD COLUMN view_mode text NOT NULL DEFAULT 'authed'
  CHECK (view_mode IN ('authed','public','emails'));

CREATE TABLE drop_viewers (
  drop_id  uuid        NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  email    text        NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (drop_id, email)
);
CREATE INDEX drop_viewers_email_idx ON drop_viewers(email);
```

The `drop_viewers_email_idx` index supports the reverse-lookup used at sign-in time ("is this email on any drop's list?").

Emails are stored lowercase + NFC-trimmed. Comparisons always go through the same normaliser.

Switching modes preserves the viewer list. Rows are only removed by explicit owner action or drop deletion.

## Authorisation

Two distinct gates.

### Sign-in gate

Runs in the OAuth callback (`src/routes/auth/callback.ts`). Today it admits a Google login iff the email matches `ALLOWED_DOMAIN` or exists in `allowed_emails`. The new rule admits if *any* of:

1. email domain matches `ALLOWED_DOMAIN`
2. email is in `allowed_emails`
3. at least one drop has `view_mode = 'public'`
4. email appears in `drop_viewers` on at least one drop

(3) and (4) are the new paths. Someone admitted via (3) or (4) can sign in but will 404 on every drop they are not entitled to.

### View-time gate

Runs in the content-serve route after the session is resolved and the drop is looked up. Single pure function:

```
canView(user, drop):
  if user.id == drop.ownerId: allow
  switch drop.view_mode:
    'public': allow
    'authed': allow iff user passes global allowlist
    'emails': allow iff drop_viewers contains (drop.id, lower(user.email))
```

Failure returns the same 404 as "drop does not exist" — no leaking of existence or mode.

The `authed` branch re-checks the global allowlist because the sign-in gate now admits some users who don't pass it (via (3) or (4)).

Revocation is immediate: every request re-checks, so removing an email from a viewer list takes effect on the viewer's next navigation. No session invalidation is required.

## UI and routes

### Edit-drop page

New "Who can view" section:

- Radio group (`authed` / `public` / `emails`) — submitting changes mode via `POST /app/drops/:name/permissions`
- Viewer list block, rendered only when `mode = 'emails'`:
  - Table of existing emails; each row is a tiny form posting to `POST /app/drops/:name/viewers/:email/delete`
  - Input + "Add" button posting to `POST /app/drops/:name/viewers`

The viewer-list block is server-rendered on mode-flip (form submit + full reload), not toggled by client-side JS. Keeps the edit page JS-free apart from the existing upload widget.

### Validation on add

- lowercase + NFC-trim
- simple `x@y.z` regex
- duplicate add → `ON CONFLICT DO NOTHING` (no error surfaced to owner)
- malformed → flash error rendered on the edit page

Removing the last email while in `emails` mode is allowed. The drop just becomes unviewable by anyone but the owner — a valid state.

### Dashboard

One new column in the owner's drop list query to drive a small badge: `public` for public drops, `list` for `emails` drops, nothing for `authed`.

### New routes (all owner-only, `requireAppSession`, CSRF-protected, on `APP_ORIGIN`)

- `POST /app/drops/:name/permissions` — body `{ mode }`
- `POST /app/drops/:name/viewers` — body `{ email }`
- `POST /app/drops/:name/viewers/:email/delete`

Ownership is checked via the existing `findByOwnerAndName(req.user.id, name)` pattern used by the other edit-drop routes.

## Tests

### Unit (`tests/unit/`)

- `canView` — matrix across `{owner, global-allowed user, list-only user, random user}` × `{authed, public, emails}`
- email normalisation (lowercase + NFC trim + regex)
- `drop_viewers` service: add/remove/list, idempotent add, cascade on drop delete

### Integration (`tests/integration/`)

- Outsider whose email is on a drop's viewer list can sign in; can view that drop; 404s on other drops
- Any Google email can sign in when any public drop exists; 404s on `authed`-mode drops
- Owner can view their own drop in any mode, including `emails` with themselves not listed
- Permission and viewer routes: happy paths plus 403 when a non-owner posts
- Revocation: remove email → next request returns 404

### E2E (Playwright)

One happy-path scenario: owner switches a drop to `emails`, adds a viewer, the viewer signs in from a fresh browser and views the drop, owner removes them, viewer now gets 404.

## Delivery order

1. Schema + Drizzle migration
2. Email normalisation helper; `drop_viewers` service; `canView` function
3. Sign-in gate update in the OAuth callback
4. Content-serve gate update
5. App routes + edit-drop view updates + dashboard badges
6. Tests (unit, integration, one e2e)
