# Drop folders — design

## Purpose

Group drops into folders on the dashboard. Organisational UI only: drop URLs are unchanged, per-drop origin isolation is untouched, no change to auth, CSRF, or handoff. This is a dashboard-rendering feature with a small data model on the side.

## Decisions

- **Purpose:** dashboard organisation only. URLs stay `<user>--<drop>.<root>`.
- **Ownership:** shared namespace. Any member can create, rename, move, or delete folders.
- **Nesting:** unbounded tree.
- **Drop-to-folder:** single parent (one `folder_id` column on `drops`), or root if null.
- **Moving drops:** any member can file any drop *they can see* (fully collaborative, subject to the existing drop visibility rules in `listAllVisible`).
- **Deleting a non-empty folder:** reparents all children (folders and drops) up one level; requires a confirmation dialog that spells out what will move where.
- **Dashboard layout:** one unified folder tree. A "Mine only" toggle filters drops without hiding folders.
- **Folder structure mutations (create/rename/move/delete):** any member, regardless of what drops the folder contains. See the visibility section below.

## Data model

New table `folders`:

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | text not null | validated (see below) |
| `parent_id` | uuid null | FK → `folders(id)` `ON DELETE RESTRICT`; reparenting handled in code |
| `created_by` | uuid not null | FK → `users(id)`; attribution only |
| `created_at` | timestamptz not null | default `now()` |

Constraints and indexes:

- `CHECK (id <> parent_id)`.
- Sibling-name uniqueness via two partial unique indexes (Postgres treats NULLs as distinct):
  - `UNIQUE (parent_id, name) WHERE parent_id IS NOT NULL`
  - `UNIQUE (name) WHERE parent_id IS NULL`
- Cycle prevention enforced in the service layer on move (walk ancestors; reject if the new parent descends from the folder being moved).

On `drops`:

- `folder_id uuid REFERENCES folders(id) ON DELETE SET NULL`.
- Index on `drops.folder_id`.

`ON DELETE SET NULL` is a safety net; the normal delete path reparents through the service.

## Name validation

Folder names: 1–64 characters, NFC-normalised, trimmed of leading/trailing whitespace, no control characters, no slashes. No cross-namespace uniqueness check against drop names — the two namespaces don't collide.

## Visibility and `emails` drops

Drops with `view_mode = 'emails'` are hidden on the dashboard from members who aren't in the viewer list. Folders sit above that filter, so both rendering and mutation have to respect it.

**Rendering.** The dashboard tree is built from the set of drops the current member can see — the same filter `listAllVisible` already applies. Folder item counts displayed in the UI (badges, delete confirmation) are computed over that visible set, never the full table. This means one member may see "3 drops" in a folder while another sees "5". That divergence is intentional — the alternative leaks existence of hidden drops.

**Folder structure mutations.** Create, rename, move, and delete a folder are allowed to any member — folder identity carries no sensitive data. Delete reparents the full contents server-side (visible and hidden alike) so no drop is orphaned by a mutation from a member who couldn't see it.

**Drop mutations** (move a drop into or out of a folder) are gated by per-viewer visibility. `setDropFolder(user, dropId, folderId | null)` checks that the drop is visible to `user` (same rule as `listAllVisible`) before mutating. Hidden drops can't be filed by members who can't see them, closing the leak.

**Delete confirmation copy** reports only the visible counts. No caveat about hidden drops — that would leak existence. Hidden drops are reparented silently by the transaction (they don't lose data; they just move up one level) and the owner sees them at the new location next time they load the dashboard.

> Delete folder "reports"? 3 drops and 1 subfolder will move up to "2026". This can't be undone.

## Service layer

`src/services/folders.ts` exposes the mutations; routes stay thin.

- `createFolder(name, parentId?)`
- `renameFolder(id, name)`
- `moveFolder(id, newParentId)` — runs the cycle check and sibling-uniqueness recheck
- `deleteFolderReparenting(id)` — reparents children (folders and drops) to the folder's parent, then deletes the row, all in one transaction
- `setDropFolder(user, dropId, folderId | null)` — visibility-checked against `user`

**Concurrency.** Folder-structure mutations (`createFolder`, `renameFolder`, `moveFolder`, `deleteFolderReparenting`) take a transaction-scoped advisory lock on a constant key (`pg_advisory_xact_lock(<folders-tree-key>)`) as the first statement of the transaction. That serialises all structural changes to the tree, eliminating the race where two concurrent `moveFolder` calls could each pass their own ancestor-walk cycle check and together introduce a cycle. Structural mutations are rare and the lock is held briefly; this is the simplest correct option for a single-instance app. `setDropFolder` does not take the lock — it only touches `drops.folder_id`, never mutates the folder tree itself, and can't introduce a cycle.

Routes key drops by `drop.id`, not `(owner, name)`. Drops are globally unique by id; name uniqueness is per-owner and is not stable enough for a cross-owner mutation. The dashboard tree carries `drop.id` on every row and every move-popover submission.

Sibling-name collisions during reparent: **folders only** (drops are never renamed — their name is URL-bound by the per-drop origin). Deterministic scheme for a colliding folder named `X` being reparented into a level that already has `X`:

1. Try `"X (from <deleted-folder>)"`.
2. If that exceeds 64 characters, truncate the base to fit the `" (from …)"` suffix. If the suffix alone would exceed 64, truncate the suffix and append an ellipsis.
3. If the result still collides, append ` (1)`, ` (2)`, … until free, truncating the base further as needed.

The rename happens inside the same transaction as the delete, so no concurrent writer can interleave. Drops that would collide cannot exist: drop names are unique per owner, not per folder, so two drops with the same name in different folders can only occur across different owners — folders don't participate in that uniqueness at all.

## Routes

All under the app origin, CSRF-protected, wired via `onAppHost` in a new `src/routes/app/folders.ts`. `POST` throughout, matching the existing dashboard pattern. Responses are 303 redirects back to the dashboard; validation errors re-render with an inline banner (400).

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/app/folders` | `{ name, parentId? }` |
| `POST` | `/app/folders/:id/rename` | `{ name }` |
| `POST` | `/app/folders/:id/move` | `{ parentId: uuid \| null }` |
| `POST` | `/app/folders/:id/delete` | — |
| `POST` | `/app/drops/:id/folder` | `{ folderId: uuid \| null }` — keyed by drop id, not name |

A JSON flavour (for async drag-and-drop) is deferred until there's a reason.

## Dashboard UI

The `GET /app/` handler builds an in-memory tree once per request. The tree needs the *full* per-viewer visible drop set, not today's paginated `listAllVisible(user, 25, 0)` call — folders would otherwise render with truncated counts. A new `listAllVisibleUnpaged(user)` (or an optional limit) returns every visible drop for the current member. Shape: `{ folders: Map<id, {folder, children: id[], drops: VisibleDrop[]}>, rootFolderIds, rootDrops }`. EJS recurses with a `_folderNode.ejs` partial.

- Ordering: folders before drops; alphabetical within each level.
- Folder row: chevron, name, item-count badge (visible count only), inline actions (rename, move, delete).
- Empty folders show a muted "(empty)" placeholder.

**Drop rows in the mixed-owner tree.** Every row renders owner attribution as a small owner pill (same component used in today's "Everyone's drops" section). Actions depend on ownership:

| | Open | Move | Edit |
| --- | :---: | :---: | :---: |
| Your own drop | ✓ | ✓ | ✓ |
| Someone else's drop (visible to you) | ✓ | ✓ | — |

"Edit" routes to `/app/drops/<name>` as today; it's suppressed on non-owned rows because the edit page is owner-only. Size/file-count columns render for every drop.

**"Mine only" toggle.** Server-side — `GET /app/?mine=1` re-renders with drops filtered to `ownerId === currentUserId`. Folders always render, even empty-in-view ones. Folder badge counts reflect the current view (so a folder's badge reads "2" under "Mine only" if two of your drops are inside, regardless of how many other members' drops are there). This matches how the rest of the dashboard behaves (no client-side filtering state anywhere else in the app) and keeps the server as the single source of truth for counts.

Move UX: a small popover lists every folder as an indented path (`reports / 2026 / Q2`) plus `— root —`. Pick one, `POST`, 303 back. No drag-and-drop in v1.

Create UX: `New folder` button opens a modal with name + parent picker (same indented list).

Delete confirmation: a small modal (not `window.confirm`, because the copy interpolates counts and destination). Counts come from a pre-delete query scoped to the viewer's visibility (see "Visibility and `emails` drops" above).


## Migration

One Drizzle migration:

1. `CREATE TABLE folders (...)` with the `CHECK` and the two partial unique indexes.
2. `ALTER TABLE drops ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL`.
3. `CREATE INDEX` on `drops.folder_id`.

No data backfill — every drop starts at root.

## Tests

TDD order: migration + schema → unit validators → service layer with integration tests (red/green per operation) → routes → EJS → E2E smoke.

**Unit** (`tests/unit/folders.test.ts`):

- Name validator: length, control chars, slashes, NFC.
- Cycle detector against a small in-memory tree — self, parent, grandparent, sibling.

**Integration** (`tests/integration/folders.test.ts`, real Postgres):

- Create at root; create nested; sibling-name collision → 400.
- Rename: success; collision with sibling.
- Move: success; move into own descendant rejected; move into self rejected.
- Move concurrency: two `moveFolder` calls that would jointly introduce a cycle are serialised by the advisory lock; one succeeds, the other sees the updated tree and rejects.
- Delete with contents: children and drops reparent up; counts used by the dialog are correct; sibling-name collision during reparent triggers the `"(from X)"` rename.
- `setDropFolder`: member A files member B's public/authed drop — succeeds.
- `setDropFolder`: member A tries to file a member-B `emails` drop they're not listed on — rejected (not visible).
- `setDropFolder`: member A tries to file a member-B `emails` drop they *are* listed on — succeeds.
- Folder badge counts rendered to a viewer reflect only drops visible to that viewer.
- Delete confirmation copy reports only visible counts, regardless of whether the folder also contains drops invisible to the actor; no caveat line is rendered.
- Hidden drops inside a deleted folder are reparented by the transaction and become visible at the parent level to members who could already see them.
- `ON DELETE SET NULL` fires if a `folders` row is deleted out-of-band.
- CSRF missing → 403 on every mutation route.
- Delete-time sibling collision: rename fallback produces a valid ≤64-char name; repeated collisions append `(1)`, `(2)`, …; drops are never renamed.

**E2E** (`tests/e2e/folders.spec.ts`, Playwright):

- Create folder, create drop, move drop into folder, reload — still inside.
- "Mine only" toggle filters drops but not folders.
- Delete non-empty folder via the confirm dialog; children bubble up.

## Out of scope (v1)

- Drag-and-drop.
- Per-folder permissions or per-folder view modes.
- Folder descriptions or icons.
- Bulk move.
- Search across folders.
- JSON API flavour of the mutation routes.
