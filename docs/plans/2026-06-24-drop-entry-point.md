# Drop Entry-Point Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a drop viewable at its bare root even when the upload has no root `index.html`, by detecting an entry page at upload time and letting the owner pick/preview one on the edit page when it's ambiguous.

**Architecture:** Add a nullable `entry_path` pointer to `drop_versions`. The serve path reads it for the bare root (`/` only) — serving a root-level entry's bytes or 302-redirecting to a nested entry's directory. Entry detection at upload replaces the physical `index.html` copy. The edit page lists HTML candidates with per-candidate preview links and a `POST .../entry` setter.

**Tech stack:** Fastify + TypeScript (ESM, `@/*` paths), Drizzle/Postgres, Cloudflare R2 (S3 SDK), EJS views, Vitest (forks, serial; integration needs `docker compose up -d`), Playwright e2e.

**Design doc:** `docs/plans/2026-06-24-drop-entry-point-design.md` (Codex-approved).

**Conventions (from CLAUDE.md):** every `.ts` starts with two `// ABOUTME:` lines; no inline JS/CSS in views (strict app CSP — `tests/unit/views-csp.test.ts` guards this); British English in copy; smallest reasonable change; TDD; frequent commits.

**Run a single test:** `pnpm test -- tests/unit/<file>.test.ts` or `pnpm test -- -t "<name>"`. Integration/serve tests need `docker compose up -d` first (Postgres `55432`, MinIO `9000`). `pnpm typecheck` and `pnpm lint` need no docker.

---

## Task 1: `encodePath` helper

Segment-wise URL encoding, shared by the serve redirect and the edit-page preview links. Stored paths may contain spaces / reserved chars (`Proptics Website.html`).

**Files:**
- Modify: `src/lib/path.ts` (add `encodePath`; keep existing `sanitisePath`)
- Test: `tests/unit/path.test.ts` (existing file — add cases)

**Step 1: Write the failing test** — append to `tests/unit/path.test.ts`:

```ts
import { encodePath } from '@/lib/path';

describe('encodePath', () => {
  it('encodes each segment but preserves slashes', () => {
    expect(encodePath('ui_kits/proptics-app/index.html')).toBe('ui_kits/proptics-app/index.html');
  });
  it('escapes spaces and reserved chars per segment', () => {
    expect(encodePath('Proptics Website.html')).toBe('Proptics%20Website.html');
    expect(encodePath('a b/c?d.html')).toBe('a%20b/c%3Fd.html');
  });
  it('preserves a trailing slash (directory target)', () => {
    expect(encodePath('ui_kits/proptics-app/')).toBe('ui_kits/proptics-app/');
  });
});
```

**Step 2: Run, expect fail** — `pnpm test -- tests/unit/path.test.ts` → FAIL (`encodePath` not exported).

**Step 3: Implement** — add to `src/lib/path.ts`:

```ts
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
```

(`encodeURIComponent('')` is `''`, so a trailing slash round-trips.)

**Step 4: Run, expect pass** — `pnpm test -- tests/unit/path.test.ts` → PASS.

**Step 5: Commit**

```bash
git add src/lib/path.ts tests/unit/path.test.ts
git commit -m "feat: add segment-wise encodePath helper"
```

---

## Task 2: Schema — `entry_path` column + propagate through `DropSummary`

No behaviour change yet; `entry_path` stays `NULL`. This unblocks reading it in serve/edit.

**Files:**
- Modify: `src/db/schema.ts` (~line 57-66, `dropVersions`)
- Generate: `src/db/migrations/*` (via `pnpm db:generate`)
- Modify: `src/services/drops.ts` (`DropSummary.version`, `toSummary`, `VisibleRow`, `toListItem`, both raw SQL `SELECT`s in `listAllVisible*`)

**Step 1: Add the column** — in `src/db/schema.ts`, inside `dropVersions`, after `fileCount`:

```ts
  entryPath: text('entry_path'),
```

(Nullable — no `.notNull()`. `text` is already imported.)

**Step 2: Generate the migration**

```bash
pnpm db:generate
```

**Step 3: Inspect the generated migration** — read the newest file in `src/db/migrations/`. Confirm it is a single `ALTER TABLE "drop_versions" ADD COLUMN "entry_path" text;` and does **not** drop/recreate the composite FK `drops.current_version -> drop_versions(id, drop_id)` (see CLAUDE.md "Schema note"). If Drizzle tries to touch that FK, hand-trim the migration to the `ADD COLUMN` only.

**Step 4: Propagate through the summary** — in `src/services/drops.ts`:

- `DropSummary.version` object type: add `entryPath: string | null;`
- `toSummary`: in the `version` object add `entryPath: v.entryPath,`
- `VisibleRow` type: add `entry_path: string | null;`
- both `SELECT`s in `listAllVisible` / `listAllVisibleUnpaged`: add `v.entry_path,` to the column list
- `toListItem`: in the `version` object add `entryPath: row.entry_path,`

**Step 5: Verify** — `pnpm typecheck` → PASS (no test yet; covered by later tasks).

**Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/services/drops.ts
git commit -m "feat: add nullable entry_path to drop_versions"
```

---

## Task 3: `detectEntryPath` + wire into upload; remove the physical copy

Replace `promoteSingleHtmlToIndex` (physical copy) with a pure detection function whose result is stored as `entry_path`.

**Files:**
- Modify: `src/services/upload.ts` (remove `promoteSingleHtmlToIndex` + now-unused S3 imports; add `detectEntryPath`)
- Modify: `src/routes/app/upload.ts` (call `detectEntryPath`, pass `entryPath` to the version insert)
- Test: `tests/unit/detect-entry.test.ts` (new)
- Test: upload-route persistence — extend an existing `tests/integration/upload*.test.ts`, or add `tests/integration/upload-entry.test.ts`
- Update: any existing test referencing `promoteSingleHtmlToIndex` (grep first)

**Step 1: Write the failing unit test** — `tests/unit/detect-entry.test.ts`:

```ts
// ABOUTME: Unit tests for detectEntryPath — choosing a drop's homepage from its file list.
// ABOUTME: Covers root index, single nested index, single html, and ambiguous/no-html cases.
import { describe, it, expect } from 'vitest';
import { detectEntryPath } from '@/services/upload';

describe('detectEntryPath', () => {
  it('returns null when a root index.html exists (default lookup finds it)', () => {
    expect(detectEntryPath(['index.html', 'style.css'])).toBeNull();
  });
  it('picks the sole nested index.html', () => {
    expect(detectEntryPath(['ui_kits/app/index.html', 'assets/x.css'])).toBe('ui_kits/app/index.html');
  });
  it('picks the sole html when there is no index.html', () => {
    expect(detectEntryPath(['Proptics Website.html', 'assets/x.css'])).toBe('Proptics Website.html');
  });
  it('treats .htm like .html', () => {
    expect(detectEntryPath(['home.htm', 'a.css'])).toBe('home.htm');
  });
  it('returns null (ambiguous) for multiple root htmls', () => {
    expect(detectEntryPath(['Home.html', 'About.html'])).toBeNull();
  });
  it('returns null (ambiguous) for multiple index.html', () => {
    expect(detectEntryPath(['a/index.html', 'b/index.html'])).toBeNull();
  });
  it('returns null when there is no html at all', () => {
    expect(detectEntryPath(['doc.pdf', 'img.png'])).toBeNull();
  });
});
```

**Step 2: Run, expect fail** — `pnpm test -- tests/unit/detect-entry.test.ts` → FAIL (`detectEntryPath` not exported).

**Step 3: Implement** — in `src/services/upload.ts`, replace the `promoteSingleHtmlToIndex` function (and its `encodeCopySource` helper) with:

```ts
export function detectEntryPath(paths: string[]): string | null {
  if (paths.includes('index.html')) return null; // root index.html — default lookup serves it
  const indexes = paths.filter((p) => p.split('/').pop() === 'index.html');
  if (indexes.length === 1) return indexes[0]!;
  if (indexes.length >= 2) return null; // ambiguous — owner picks
  const htmls = paths.filter((p) => /\.html?$/i.test(p));
  if (htmls.length === 1) return htmls[0]!;
  return null; // ambiguous or no html
}
```

Remove the now-unused imports from `src/services/upload.ts`: `CopyObjectCommand`, `DeleteObjectsCommand`, and `s3`/`config` **iff** nothing else in the file uses them (check before deleting).

**Step 4: Write the failing upload-route integration test** (needs docker — `docker compose up -d`). Model it on the existing `tests/integration/upload*.test.ts` harness. Upload through the real `POST /app/drops/:name/upload` endpoint and assert `(await findByOwnerAndName(ownerId, name))!.version!.entryPath`:
- single nested `index.html` zip/folder → `entryPath === 'sub/index.html'`
- single root non-index html → `entryPath === '<that file>'`
- a root `index.html` present → `entryPath === null`
- multiple root htmls (ambiguous) → `entryPath === null`

Run: `pnpm test -- tests/integration/upload-entry.test.ts` → FAIL (route not wired yet).

**Step 5: Wire into the upload route** — in `src/routes/app/upload.ts`:

- Replace the import `promoteSingleHtmlToIndex` with `detectEntryPath`.
- Delete the `try { result = await promoteSingleHtmlToIndex(...) } catch {...}` block.
- Before the DB transaction: `const entryPath = detectEntryPath(result.files.map((f) => f.path));`
- In `tx.insert(dropVersions).values({...})` add `entryPath,`.

**Step 6: Update displaced tests** — `grep -rn promoteSingleHtmlToIndex tests src`. Any test that asserted "single root html is copied to `index.html`" must change to assert `entry_path` is set to that file (serve behaviour lands in Task 4). Convert such assertions; do not delete coverage.

**Step 7: Run** — `pnpm test -- tests/unit/detect-entry.test.ts tests/integration/upload-entry.test.ts` → PASS. Then `pnpm typecheck` → PASS, `pnpm lint` → PASS (catches unused imports).

**Step 8: Commit**

```bash
git add src/services/upload.ts src/routes/app/upload.ts tests
git commit -m "feat: detect entry page at upload, store as entry_path"
```

---

## Task 4: Serve bare-root entry behaviour

`/` (root only) uses `entry_path`: serve a root-level entry's bytes, or 302-redirect to a nested entry. Must not loop and must percent-encode the redirect target.

**Files:**
- Modify: `src/routes/content/dropServe.ts` (the `serve` function, ~lines 32-49)
- Test: `tests/integration/drop-serve-entry.test.ts` (new) — model on existing `tests/integration/drop-serve*.test.ts`

**Step 1: Read a sibling test** — open the existing drop-serve integration test to copy the upload+session+request harness (how it creates a drop version, sets the drop cookie, and issues `GET` against the drop host). Reuse those helpers; do not invent new ones.

**Step 2: Write failing integration tests** covering:
- Root-level entry (`entry_path = 'page.html'`, no `index.html`) → `GET /` returns 200 and that file's body.
- Nested `index.html` entry (`entry_path = 'sub/index.html'`) → `GET /` returns 302 with `Location: /sub/` (note trailing slash, no `index.html`).
- Nested non-index entry (`entry_path = 'sub/home.html'`) → `GET /` returns 302 with `Location: /sub/home.html`.
- **No redirect loop:** following the 302 (`GET /sub/`) returns 200 (the dir→`index.html` fallback), not another 302.
- **Encoding:** root-level `entry_path = 'Proptics Website.html'` → `GET /` 200; nested `entry_path = 'a b/index.html'` → `Location: /a%20b/`.
- Regression: a drop with a real root `index.html` and `entry_path = NULL` → `GET /` unchanged.

Run: `docker compose up -d` then `pnpm test -- tests/integration/drop-serve-entry.test.ts` → FAIL.

**Step 3: Implement** — in `src/routes/content/dropServe.ts`, replace the current block:

```ts
  let rest = splat;
  const bareRoot = rest === '' || rest.endsWith('/');
  if (bareRoot) rest += 'index.html';
```

with:

```ts
  let rest = splat;
  const isRoot = rest === '';
  const entry = drop.version.entryPath;
  if (isRoot && entry) {
    if (entry.includes('/')) {
      const segs = entry.split('/');
      const target = segs[segs.length - 1] === 'index.html'
        ? segs.slice(0, -1).join('/') + '/'
        : entry;
      return reply.redirect('/' + encodePath(target), 302);
    }
    rest = entry; // root-level entry → serve its bytes at /
  } else if (rest === '' || rest.endsWith('/')) {
    rest += 'index.html';
  }
```

Add `import { encodePath } from '@/lib/path';` (alongside `sanitisePath`). Update the single-file fallback condition further down from `bareRoot` to `isRoot` (a lone file should only auto-serve at the true root, not at `/subdir/`). Remove the now-unused `bareRoot` binding if nothing else references it.

**Step 4: Run** — `pnpm test -- tests/integration/drop-serve-entry.test.ts` → PASS.

**Step 5: Commit**

```bash
git add src/routes/content/dropServe.ts tests/integration/drop-serve-entry.test.ts
git commit -m "feat: serve entry_path at drop root (bytes or redirect)"
```

---

## Task 5: `setEntryPath` service + `POST /app/drops/:name/entry` route

**Files:**
- Modify: `src/services/drops.ts` (add `setEntryPath`)
- Create: `src/routes/app/setEntry.ts`
- Modify: `src/index.ts` (register `setEntryRoute` under `onAppHost`, near `setPermissionsRoute`)
- Test: `tests/integration/set-entry.test.ts` (new)

**Step 1: Write failing integration tests:**
- Owner POSTs a valid html path present in the current version → 302 to `/app/drops/:name`; `entry_path` is updated; `GET /` on the drop host then serves/redirects accordingly.
- POST with a path not in the version, or a non-`.html`/`.htm` path → 400 `bad_entry`; `entry_path` unchanged.
- POST `entry=""` → clears to `NULL`.
- Non-owner (or unknown drop) → 404 (no enumeration), mirroring `setPermissions`.

Run with docker up → FAIL.

**Step 2: Implement the service** — in `src/services/drops.ts`:

```ts
export async function setEntryPath(versionId: string, entryPath: string | null): Promise<void> {
  await db.update(dropVersions).set({ entryPath }).where(eq(dropVersions.id, versionId));
}
```

**Step 3: Implement the route** — `src/routes/app/setEntry.ts`:

```ts
// ABOUTME: POST /app/drops/:name/entry — owner sets the version's homepage (entry_path).
// ABOUTME: Validates the chosen path is an .html/.htm file in the current version; non-owner returns 404.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { findByOwnerAndName, setEntryPath } from '@/services/drops';
import { listPrefix } from '@/lib/r2';
import { isValidSlug } from '@/lib/slug';
import { config } from '@/config';

export const setEntryRoute: FastifyPluginAsync = async (app) => {
  app.post('/app/drops/:name/entry', { preHandler: requireCompletedMember }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSlug(name)) return reply.code(404).send('not_found');
    const drop = await findByOwnerAndName(req.user!.id, name);
    if (!drop || !drop.version) return reply.code(404).send('not_found');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const entry = body.entry ?? ''; // exact stored path — do NOT trim (filenames may have edge whitespace)

    if (entry === '') {
      await setEntryPath(drop.version.id, null);
      return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
    }

    const prefix = drop.version.r2Prefix;
    const rels = (await listPrefix(prefix)).map((k) => k.slice(prefix.length));
    if (!rels.includes(entry) || !/\.html?$/i.test(entry)) return reply.code(400).send('bad_entry');

    await setEntryPath(drop.version.id, entry);
    return reply.redirect(new URL(`/app/drops/${name}`, config.APP_ORIGIN).toString(), 302);
  });
};
```

**Step 4: Wire in `src/index.ts`** — import `setEntryRoute` and `await s.register(setEntryRoute);` inside the `onAppHost(...)` block alongside `setPermissionsRoute`.

**Step 5: Run** — `pnpm test -- tests/integration/set-entry.test.ts` → PASS; `pnpm typecheck` → PASS.

**Step 6: Commit**

```bash
git add src/services/drops.ts src/routes/app/setEntry.ts src/index.ts tests/integration/set-entry.test.ts
git commit -m "feat: add POST /app/drops/:name/entry to set the homepage"
```

---

## Task 6: Edit page — candidates, picker, preview link

**Files:**
- Modify: `src/routes/app/editDrop.ts` (compute candidates + preview URLs + picker state)
- Modify: `src/views/editDrop.ejs` (entry block in the "Current version" card)
- Modify: `src/views/static/edit-drop.js` (preview-link sync)
- Test: `tests/integration/edit-drop-entry.test.ts` (new); rely on existing `tests/unit/views-csp.test.ts` for CSP

**Step 1: Write failing integration tests** (against the app host, owner session):
- Ambiguous drop (multiple htmls, no root index, `entry_path` NULL) → edit page HTML contains the picker with each html as an `<option>` and the "pick a homepage" prompt.
- No-HTML drop (lone PDF) → edit page shows the neutral "no homepage" note and **no** `<select>`.
- Drop with `entry_path` set → that option is pre-selected.

Run → FAIL.

**Step 2: Extend the route** — in `src/routes/app/editDrop.ts`, after loading `drop`, before `reply.view`:

```ts
import { listPrefix } from '@/lib/r2';
import { encodePath } from '@/lib/path';
// ...
let entryCandidates: { path: string; preview: string }[] = [];
let showEntryPicker = false;
let homepageResolves = true;
let currentEntry = '';
if (drop.version) {
  const prefix = drop.version.r2Prefix;
  const rels = (await listPrefix(prefix)).map((k) => k.slice(prefix.length));
  const base = dropOriginFor(user.username!, name);
  entryCandidates = rels
    .filter((p) => /\.html?$/i.test(p))
    .map((p) => ({ path: p, preview: `${base}/${encodePath(p)}` }));
  currentEntry = drop.version.entryPath ?? '';
  homepageResolves = rels.includes('index.html') || drop.version.entryPath != null || drop.version.fileCount === 1;
  showEntryPicker = !homepageResolves && entryCandidates.length > 0;
}
```

Pass `entryCandidates, showEntryPicker, homepageResolves, currentEntry` into the `reply.view('editDrop.ejs', { ... })` object.

**Step 3: Add the EJS block** — inside the `version-card`, after the `<% if (drop.version) { %> <dl class="version-kv">…</dl>` and before the card closes:

```html
<% if (drop.version && entryCandidates.length) { %>
  <form method="post" action="/app/drops/<%= drop.name %>/entry" class="entry-form<%= showEntryPicker ? ' needs-entry' : '' %>">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <label class="entry-label" for="entry-select">Homepage (served at <code>/</code>)</label>
    <% if (showEntryPicker) { %>
      <p class="hint err">No homepage found — choose the page to serve at <code>/</code>.</p>
    <% } %>
    <div class="entry-row">
      <select id="entry-select" name="entry">
        <option value=""<%= currentEntry === '' ? ' selected' : '' %>>— none (use index.html) —</option>
        <% entryCandidates.forEach(function(c) { %>
          <option value="<%= c.path %>" data-preview="<%= c.preview %>"<%= currentEntry === c.path ? ' selected' : '' %>><%= c.path %></option>
        <% }) %>
      </select>
      <a id="entry-preview" class="btn ghost sm" href="#" target="_blank" rel="noopener" hidden>Preview ↗</a>
      <button class="btn primary sm" type="submit">Save</button>
    </div>
  </form>
<% } else if (drop.version && !homepageResolves) { %>
  <p class="hint">This drop has no HTML page, so <code>/</code> has nothing to show. Upload an <code>index.html</code> or a single HTML file.</p>
<% } %>
```

EJS auto-escapes `<%= %>`, so paths with spaces/quotes are attribute-safe.

**Step 4: Add the JS handler** — inside the IIFE in `src/views/static/edit-drop.js`:

```js
  const entrySel = document.getElementById('entry-select');
  const entryPrev = document.getElementById('entry-preview');
  if (entrySel && entryPrev) {
    const sync = () => {
      const opt = entrySel.options[entrySel.selectedIndex];
      const url = opt && opt.dataset.preview;
      if (url) { entryPrev.href = url; entryPrev.hidden = false; }
      else { entryPrev.hidden = true; }
    };
    entrySel.addEventListener('change', sync);
    sync();
  }
```

**Step 5: Run** — `pnpm test -- tests/integration/edit-drop-entry.test.ts` → PASS; `pnpm test -- tests/unit/views-csp.test.ts` → PASS (no inline JS/CSS added). Add minimal styles for `.entry-row`/`.needs-entry` to `src/views/static/style.css` if needed — keep it in the stylesheet, never inline.

**Step 6: Commit**

```bash
git add src/routes/app/editDrop.ts src/views/editDrop.ejs src/views/static/edit-drop.js src/views/static/style.css tests/integration/edit-drop-entry.test.ts
git commit -m "feat: entry-page picker with preview on the edit page"
```

---

## Task 7: Full verification

**Step 1:** `docker compose up -d` (if not already).
**Step 2:** `pnpm typecheck` → PASS.
**Step 3:** `pnpm lint` → PASS.
**Step 4:** `pnpm test` → all PASS, output pristine (no stray error logs).
**Step 5:** Manually re-check the two motivating zips against the new behaviour (the design doc's worked examples): "Proptics Design System" (nested single index → auto-detected) and "Market insight…" (multiple htmls → picker).
**Step 6:** If `README.md`/`CLAUDE.md` describe the "must have index.html at root" behaviour, update that note. Commit any doc change.

```bash
git commit -am "docs: note entry-page detection/override behaviour"
```

---

## Notes / gotchas

- **No backfill:** existing drops have a real `index.html`; `entry_path IS NULL` falls through to the current lookup. Don't write a data migration.
- **Re-upload resets the choice:** a new version re-runs detection (per-version `entry_path`). Acceptable per design — no per-drop preference (YAGNI).
- **Redirect-loop trap:** the entry redirect fires only when `splat === ''` (true root), never for `/subdir/` — otherwise a nested `index.html` entry loops. The Task 4 test guards this.
- **Removing the physical copy** changes what's in R2 after a single-root-html upload (no synthesised `index.html`). Update, don't delete, any test asserting the old copy.
- **Dead code:** `createDropAndVersion`/`replaceVersion` in `drops.ts` are unused by the upload path — leave them unless a test references them; don't thread `entryPath` through them speculatively.
