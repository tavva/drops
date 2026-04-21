# Drop folders — design

## Purpose

Group drops into folders on the dashboard. Organisational UI only: drop URLs are unchanged, per-drop origin isolation is untouched, no change to auth, CSRF, or handoff. This is a dashboard-rendering feature with a small data model on the side.

## Decisions

- **Purpose:** dashboard organisation only. URLs stay `<user>--<drop>.<root>`.
- **Ownership:** shared namespace. Any member can create, rename, move, or delete folders.
- **Nesting:** unbounded tree.
- **Drop-to-folder:** single parent (one `folder_id` column on `drops`), or root if null.
- **Moving drops:** any member can file any drop (fully collaborative).
- **Deleting a non-empty folder:** reparents all children (folders and drops) up one level; requires a confirmation dialog that spells out what will move where.
- **Dashboard layout:** one unified folder tree. A "Mine only" toggle filters drops without hiding folders.

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

## Service layer

`src/services/folders.ts` exposes the mutations; routes stay thin.

- `createFolder(name, parentId?)`
- `renameFolder(id, name)`
- `moveFolder(id, newParentId)` — runs the cycle check and sibling-uniqueness recheck
- `deleteFolderReparenting(id)` — reparents children (folders and drops) to the folder's parent, then deletes the row, all in one transaction
- `setDropFolder(dropName, folderId | null)`

Sibling-name collisions during reparent: rename the orphaned child to `"<name> (from <deleted-folder>)"` inside the same transaction. The delete is intended to "just move things up"; failing on a collision would be surprising.

## Routes

All under the app origin, CSRF-protected, wired via `onAppHost` in a new `src/routes/app/folders.ts`. `POST` throughout, matching the existing dashboard pattern. Responses are 303 redirects back to the dashboard; validation errors re-render with an inline banner (400).

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/app/folders` | `{ name, parentId? }` |
| `POST` | `/app/folders/:id/rename` | `{ name }` |
| `POST` | `/app/folders/:id/move` | `{ parentId: uuid \| null }` |
| `POST` | `/app/folders/:id/delete` | — |
| `POST` | `/app/drops/:name/folder` | `{ folderId: uuid \| null }` |

A JSON flavour (for async drag-and-drop) is deferred until there's a reason.

## Dashboard UI

The `GET /app/` handler builds an in-memory tree once per request: `{ folders: Map<id, {folder, children: id[], drops: Drop[]}>, rootFolderIds, rootDrops }`. EJS recurses with a `_folderNode.ejs` partial.

- Ordering: folders before drops; alphabetical within each level.
- Folder row: chevron, name, item-count badge, inline actions (rename, move, delete).
- Drop row: existing fields plus a "move" action.
- Empty folders show a muted "(empty)" placeholder.

Move UX: a small popover lists every folder as an indented path (`reports / 2026 / Q2`) plus `— root —`. Pick one, `POST`, 303 back. No drag-and-drop in v1.

Create UX: `New folder` button opens a modal with name + parent picker (same indented list).

Delete confirmation: a small modal (not `window.confirm`, because the copy interpolates counts and destination) — e.g.

> Delete folder "reports"? Its 3 drops and 1 subfolder will move up to "2026". This can't be undone.

Counts come from a pre-delete query.

Filter: a single `<input type=checkbox>` "Mine only" bound to `?mine=1`. Server re-renders. Folders always show; drops are filtered by `ownerId === currentUserId`.

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
- Delete with contents: children and drops reparent up; counts used by the dialog are correct; sibling-name collision during reparent triggers the `"(from X)"` rename.
- `setDropFolder`: member A files member B's drop — succeeds (shared-namespace decision).
- `ON DELETE SET NULL` fires if a `folders` row is deleted out-of-band.
- CSRF missing → 403 on every mutation route.

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
