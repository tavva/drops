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
4. Else leave `NULL`. If two or more `.html`/`.htm` candidates exist, this is **ambiguous** — the edit page prompts the owner to pick. If there is no HTML at all, there is nothing to prompt for: serving falls back to the lone-file rule (a single PDF/image) or simply has no homepage at `/`.

Worked examples (the two real zips):
- "Market insight…" zip: four root htmls, no `index.html` → case 4 → owner picks `Proptics Website.html`.
- "Proptics Design System" zip: one `index.html`, nested two deep → case 2 → auto-picks `ui_kits/proptics-app/index.html`.

### Serve behaviour (`dropServe.ts`, bare-root `/` only)

- `entry_path` is `NULL` → unchanged: look up `index.html`, keep the lone-non-html single-file fallback (a single PDF/image still serves at `/`).
- `entry_path` set and **root-level** (no `/`) → serve its bytes at `/`. Relative `assets/…` resolve against `/`. Clean URL.
- `entry_path` set and **nested** → **302 redirect** `/` → `/<dir>/` when the basename is `index.html`, else `/<full path>`. Byte-serving a deep file at `/` would break every relative asset link; redirecting sets the browser's base correctly and lets the existing directory→`index.html` fallback serve it.

Non-bare-root requests (explicit paths, directory→`index.html` fallback) are unchanged.

**Path encoding.** Stored paths are NFC-normalised relative paths that may contain spaces or URL-reserved characters (the motivating entry is literally `Proptics Website.html`). The redirect `Location` is built by encoding each path segment with `encodeURIComponent` and re-joining with `/` (so separators survive but spaces/reserved chars are escaped) — not a bare `encodeURI`. The same segment-wise encoding applies to the preview `href` and to any path threaded through the drop bootstrap's `next` parameter. Tests must cover a space-containing entry filename end-to-end.

### Edit page (`editDrop`)

- The route lists the current version's `.html`/`.htm` files via the existing `listPrefix` and passes them as candidates, along with the current `entry_path` and the drop's content origin (`dropOriginFor`).
- The view renders an **entry-page dropdown** pre-filled with the detected entry. The prompt-to-pick state ("Pick an entry page to publish") shows only when a bare-root request would 404 **and** there are `.html`/`.htm` candidates to choose from. A drop with no HTML at all gets a neutral note ("no homepage at `/`"), not an entry picker; a drop whose `/` already resolves shows its current entry without a warning.
- Each candidate gets a **"Preview ↗" link** (`target="_blank"`, `rel="noopener"`) to that file's direct drop URL, with each path segment URL-encoded (see Path encoding above). This works because the upload already flipped `current_version`, so every candidate is live at its explicit path regardless of `entry_path` — only the bare `/` 404s. Opening it top-level runs the normal auth bootstrap (first-party cookie), so no CSP relaxation and no cross-site-iframe auth problem. (An inline iframe was rejected: it would force `frame-src` onto the app origin's CSP and hit third-party-cookie/bootstrap fragility.)
- A new `POST /app/drops/:name/entry` validates that the chosen path is a real `.html` in the current version and sets `drop_versions.entry_path`, then redirects back. Mirrors `setPermissions`.
- All behaviour rides on `data-*` attributes + `src/views/static/edit-drop.js` — no inline JS/CSS, so the CSP and `views-csp` test stay green.

## Testing (TDD)

- **Unit** — entry-detection function: table of file lists → expected `entry_path` covering every branch (root index → null; single nested index → that; single html → that; multiple htmls → null + ambiguous; multiple index → null + ambiguous; no html at all → null + not-ambiguous).
- **Integration** —
  - Nested single `index.html` zip → `GET /` (with drop session) → 302 to `/<dir>/`.
  - Single root non-index html → `GET /` → 200 serving it.
  - Ambiguous zip → `GET /` → 404; edit page lists the html candidates; `POST /entry` sets one; `GET /` then resolves (200 or 302).
  - No-HTML drop (e.g. lone PDF) → edit page shows the neutral no-homepage note, **not** the entry picker; the lone-file fallback still serves `/`.
  - Encoding — an entry filename containing a space (`Proptics Website.html`): selecting/serving it yields a correctly percent-encoded `Location` (nested) or serves at `/` (root-level), the explicit encoded path resolves, and the preview `href` is segment-encoded.
  - Existing real root `index.html` → unchanged (regression guard).
- **CSP** — `views-csp` test already fails on any inline script/handler/style in `editDrop.ejs`.

## Risks / considerations

- **Re-upload resets the manual choice.** A new version re-runs detection; if still ambiguous, the owner re-picks. Acceptable — detection covers the common cases automatically. Persisting a per-drop preference is deferred (YAGNI).
- **Multiple `index.html`** is treated as ambiguous rather than guessing the shallowest. The owner picks.
- **Nested entry changes the URL bar** to `/<dir>/`. Needed for relative-asset correctness.
- **Preview link** depends on the drop being reachable through the normal auth bootstrap — identical to viewing any drop.
