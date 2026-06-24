# Drop entry-point selection — design

Date: 2026-06-24

## Problem

A drop serves `index.html` at its bare root (`dropServe.ts` rewrites `/` → `index.html`). If the uploaded zip/folder has no `index.html` at its stored root, the root URL returns `not_found` — the user sees "Not found" even though their files uploaded fine.

This bites a common input: zips exported from Claude's design tool. They carry many top-level entries plus an entry page that is either named something other than `index.html` (e.g. `Proptics Website.html`) or buried in a subfolder (e.g. `ui_kits/proptics-app/index.html`). Two existing safety nets fail to rescue these:

- `stripSingleRoot` (in `uploadZip.ts`) only unwraps when *every* file shares one top-level folder. Many top-level entries → nothing to unwrap.
- `promoteSingleHtmlToIndex` (in `upload.ts`) only fires when there is *exactly one* `.html` at the root. Several htmls, or a nested entry → no promotion.

## Goals

- A drop whose entry page is not a root-level `index.html` should still be viewable at its bare root.
- When the entry page is unambiguous, detect it automatically at upload time.
- When it is ambiguous, let the owner pick it on the edit page, with a way to preview each candidate before committing.

## Non-goals

- No blocking multi-step upload flow. Upload stays a single atomic POST that always commits.
- No rendering of drop HTML on the app origin (would breach per-drop origin isolation).
- No persistence of the manual choice across re-uploads (a new upload re-runs detection).

## Design

### Data model

Add a nullable `entry_path` column to `drop_versions`. It is a **pointer** to the entry file within the version's R2 prefix, not a copy. Serve reads it instead of hardcoding `index.html`.

This replaces the physical copy that `promoteSingleHtmlToIndex` performs today (copying a lone root html to `index.html`). A pointer avoids duplicate R2 objects and the GC churn a copy implies.

No migration backfill: existing drops have a real `index.html`, and `entry_path IS NULL` falls through to the current `index.html` lookup, so they keep working untouched. (The column is added with the usual Drizzle generate step; mind the composite-FK raw SQL step already in the migration history — see `CLAUDE.md`.)

### Entry detection (server-side, at upload)

Replaces `promoteSingleHtmlToIndex`. Given the list of stored relative paths, choose `entry_path`:

1. `index.html` exists at the root → leave `NULL` (default lookup finds it).
2. Else exactly one file has basename `index.html` (at any depth) → use it. Catches `ui_kits/proptics-app/index.html`.
3. Else no `index.html` anywhere, and exactly one `.html`/`.htm` file in total → use it.
4. Else leave `NULL` — **ambiguous**. The edit page prompts the owner to pick.

Worked examples (the two real zips):
- "Market insight…" zip: four root htmls, no `index.html` → case 4 → owner picks `Proptics Website.html`.
- "Proptics Design System" zip: one `index.html`, nested two deep → case 2 → auto-picks `ui_kits/proptics-app/index.html`.

### Serve behaviour (`dropServe.ts`, bare-root `/` only)

- `entry_path` is `NULL` → unchanged: look up `index.html`, keep the lone-non-html single-file fallback (a single PDF/image still serves at `/`).
- `entry_path` set and **root-level** (no `/`) → serve its bytes at `/`. Relative `assets/…` resolve against `/`. Clean URL.
- `entry_path` set and **nested** → **302 redirect** `/` → `/<dir>/` when the basename is `index.html`, else `/<full path>`. Byte-serving a deep file at `/` would break every relative asset link; redirecting sets the browser's base correctly and lets the existing directory→`index.html` fallback serve it.

Non-bare-root requests (explicit paths, directory→`index.html` fallback) are unchanged.

### Edit page (`editDrop`)

- The route lists the current version's `.html`/`.htm` files via the existing `listPrefix` and passes them as candidates, along with the current `entry_path` and the drop's content origin (`dropOriginFor`).
- The view renders an **entry-page dropdown** pre-filled with the detected entry. When ambiguous (`entry_path` is `NULL` and no root `index.html`), it shows a prompt state ("Pick an entry page to publish").
- Each candidate gets a **"Preview ↗" link** (`target="_blank"`, `rel="noopener"`) to that file's direct drop URL. This works because the upload already flipped `current_version`, so every candidate is live at its explicit path regardless of `entry_path` — only the bare `/` 404s. Opening it top-level runs the normal auth bootstrap (first-party cookie), so no CSP relaxation and no cross-site-iframe auth problem. (An inline iframe was rejected: it would force `frame-src` onto the app origin's CSP and hit third-party-cookie/bootstrap fragility.)
- A new `POST /app/drops/:name/entry` validates that the chosen path is a real `.html` in the current version and sets `drop_versions.entry_path`, then redirects back. Mirrors `setPermissions`.
- All behaviour rides on `data-*` attributes + `src/views/static/edit-drop.js` — no inline JS/CSS, so the CSP and `views-csp` test stay green.

## Testing (TDD)

- **Unit** — entry-detection function: table of file lists → expected `entry_path` for each of the four cases (root index → null; single nested index → that; single html → that; multiple htmls / multiple index → null).
- **Integration** —
  - Nested single `index.html` zip → `GET /` (with drop session) → 302 to `/<dir>/`.
  - Single root non-index html → `GET /` → 200 serving it.
  - Ambiguous zip → `GET /` → 404; edit page lists the html candidates; `POST /entry` sets one; `GET /` then resolves (200 or 302).
  - Existing real root `index.html` → unchanged (regression guard).
- **CSP** — `views-csp` test already fails on any inline script/handler/style in `editDrop.ejs`.

## Risks / considerations

- **Re-upload resets the manual choice.** A new version re-runs detection; if still ambiguous, the owner re-picks. Acceptable — detection covers the common cases automatically. Persisting a per-drop preference is deferred (YAGNI).
- **Multiple `index.html`** is treated as ambiguous rather than guessing the shallowest. The owner picks.
- **Nested entry changes the URL bar** to `/<dir>/`. Needed for relative-asset correctness.
- **Preview link** depends on the drop being reachable through the normal auth bootstrap — identical to viewing any drop.
