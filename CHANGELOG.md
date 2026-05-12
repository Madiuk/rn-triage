# CHANGELOG

Notable changes to Relai. The format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/) (relaxed pre-1.0 — minor
bumps cover meaningful capability additions, patch bumps cover fixes).

---

## v0.4.0 — 2026-05-11

The Level-1 server-side cleanup. Three commits worth of work
(phases 1a, 1b, 1c) bundled under one minor version because
together they're the architectural inflection point that the
recent bug rate suggested was overdue. Behavior-preserving —
no user-visible changes, no migration required, no behavior
change risk for either of you or the staff joining soon.

User prompt was:
> "Lets go to Level 1. Be slow and methodical. If you run into
> an issue or see improvements to make along the way, go for it.
> But let's make sure this doesn't spiral and turn into a
> disaster. Clean it up. Stop duplication. Tighten up data
> access."

### Phase 1a — Server helper extraction

`netlify/functions/kb.js` had grown to 1392 lines with auth,
permissions, data-access, audit, and route logic interleaved.
Extracted into four modules under `_lib/`:

- `_lib/supabase.js` — env vars, read/write header builders,
  `json()` response helper, `isConfigured()`.
- `_lib/auth.js` — `verifyUser`, `resolveCompanyId`,
  `resolveProfile`, `extractToken`.
- `_lib/permissions.js` — **the single source of truth for role
  and row gates.** Pure helpers, no IO, fully testable.
  Exports: `isClinical`, `isNonClinical`, `isAdmin`,
  `isSuperUser`, `rowIsClinical`, `canMutateRow`,
  `canResolveReview`, `canEditClinicalCategory`,
  `canDeleteRow`, `canVoteOnDraft`, `canSaveActualResponse`,
  `canMarkEscalated`.
- `_lib/db.js` — tenant-scoped query wrappers:
  `fetchRowInTenant`, `fetchOriginTriage`, `writeAuditLog`,
  `tenantClause`, `tenantScopedPatch`, `tenantScopedDelete`.

### Phase 1b — Route handler split

Each endpoint moved into its own file under `_lib/routes/`:

| file | lines | endpoints |
|---|---|---|
| `routes/analyze.js`  |  66 | `/analyze` |
| `routes/profile.js`  |  90 | `/profile`, `/handoff-template`, `/categories` |
| `routes/kb-crud.js`  | 176 | `/kb` |
| `routes/reviews.js`  | 304 | `/reviews` (+ `promoteReviewToKB`) |
| `routes/admin.js`    | 295 | `/admin/users`, `/admin/categories`, `/admin/settings` |
| `routes/history.js`  | 390 | `/history*` (stats/cost/quality/all) |

`kb.js` is now a **70-line thin router**. Path-substring dispatch
with comments documenting the ordering constraints (`/admin/categories`
must be checked before `/categories`, etc).

Result: when adding a new endpoint or modifying a role gate, you
touch one focused file instead of a thousand-line monolith. The
two-files-out-of-sync bug pattern that produced several recent
regressions (v0.3.13 `isClinical not defined`, the `/analyze`
auth header miss, etc.) becomes structurally harder to repeat.

### Phase 1c — Server-side test coverage

The most important part. Before today the 144 tests covered
only pure helpers in `data/triage-lib.js`; every server endpoint
shipped with zero coverage. Three new test files (62 new tests):

- **`tests/permissions.test.js`** (23 tests) — every role
  classifier, `rowIsClinical`, every composite predicate.
  These predicates ARE the safety boundary; if anything here
  ever fails, a CSR could send clinical advice.

- **`tests/clinicalDetection.test.js`** (23 tests) — the
  **contract test**. Imports server's `rowIsClinical` AND
  client's `resultIsClinical`, runs them against a battery of
  22 input rows, and asserts both agree. If either side
  changes the rule, the test fails and we know to update the
  other. This kills the drift bug class that the duplicated
  logic created.

- **`tests/roleGates.test.js`** (16 tests) — end-to-end gate
  behavior. Mocks `global.fetch` with a route table, calls
  the actual route handlers with constructed events, asserts
  on the response status + body. Covers:
  - Non-clinical CANNOT delete / save_actual / update_urgency
    / downvote / set body.category on clinical rows → 403
  - Non-clinical CAN do all of those on non-clinical rows → 200
  - General Inquiry treated as non-clinical (per Big Easy seed)
  - Clinical user is never over-gated → all 200
  - `mark_escalated` succeeds for non-clinical on clinical
    rows (the CSR's outlet must always work)
  - Non-clinical CANNOT resolve clinical-origin reviews → 403
  - Non-clinical CAN resolve non-clinical-origin reviews → 200

  Total tests: 144 → 206 passing.

### Code-organization side-effects

- Client's `resultIsClinical` moved from `app.js` inline into
  `data/triage-lib.js`. The browser still loads it via the
  same `<script>` tag that's been in `index.html`. Removes one
  duplicate definition (was two — client inline and server
  inline). The remaining duplicate (server has its own copy
  in `_lib/permissions.js`) is intentional, because the server
  can't reliably require cross-directory paths inside a Netlify
  Function bundle. The contract test enforces they agree.

- `promoteReviewToKB` moved from top-of-kb.js to inside
  `_lib/routes/reviews.js` — it was only called from there.

### Not in this release

Phase 2 (client-side app.js split) is deferred to a separate
release. The frontend has the same monolith problem but
splitting it has bigger surface area (no module system in
plain HTML; state management to untangle). Better as its own
focused work, not piled on top of the server changes.

### Total impact

| metric | before | after |
|---|---|---|
| `kb.js` line count | 1392 | 70 |
| Test count | 144 | 206 |
| Largest single server file | 1392 | 390 (`history.js`) |
| Files touched per typical endpoint change | 1 | 1 |
| Files touched per role-gate change | 1 | 1 |

The line-count of any single file is dramatically smaller, the
test coverage of safety-critical code went from zero to
exhaustive, and adding a new endpoint or gate still touches
exactly one file. Net architectural lift without surface-area
expansion.

### What you should NOT see after deploy

- Any difference in app behavior. URLs, response bodies,
  error codes — all preserved byte-for-byte.
- Any change to the Inquiry / Admin / KB tabs.
- Any new operational alerts.
- Any client errors. Browser code only changed in one place
  (moving `resultIsClinical` into a file that was already
  loaded).

### What's safer now

- Adding a new role: change `_lib/permissions.js` predicates
  once, every route consults them. No more inline gate logic
  to keep in sync.
- Adding a new endpoint: drop a `routes/<name>.js`, add one
  dispatch line in `kb.js`. No risk of touching unrelated
  routes.
- Catching client/server drift on clinical detection: the
  contract test runs in CI; drift = test failure.
- Refactoring a route: confidence comes from coverage, not
  from clicking through the app.

---

## v0.3.27 — 2026-05-11

Roles, gates, escalation flow, admin panel, and the "Triage → Inquiry"
rename. Built as one cohesive release rather than three sequential
versions (would-have-been v0.3.25 plumbing + v0.3.26 gates + v0.3.27
admin) because the pieces are tightly interconnected and shipping
them separately would have meant three sets of related migrations,
duplicate scaffolding, and three rounds of partial-state risk.

### Why this matters

Big Easy is rolling out to multiple staff: Bridget (clinical) next
week, Zack (non-clinical) shortly after. Until now, the system had
no role gates — any authenticated user could send any reply on any
inquiry. Acceptable for a single-user trial; not acceptable when a
non-clinical CSR is in the workflow. v0.3.27 builds the foundation
that will keep the learning loop clean and patient safety enforced
as headcount grows.

### Migration required

**Run this in Supabase SQL Editor:**
```sql
-- Apply the new schema
-- Run the contents of migrations/0010_roles_admin_categories.sql

-- Then set yourself as super-user (replace email):
UPDATE public.profiles
   SET is_admin = true, is_super_user = true
 WHERE id = (SELECT id FROM auth.users WHERE email = 'you@example.com');
```

Migration 0010 is idempotent. Safe to re-run.

### Renamed (user-facing)

- "Triage" → "Inquiry" everywhere user-visible (tab label, page
  headings, help & guide text, button)
- "Run Triage" button → "Analyze"
- "Triage Queue" → "Inquiries"
- "Recent Triages" → "Recent Inquiries"

Internal code names (`runTriage`, `query_history` table, function
identifiers) unchanged — renaming those would be churn for no
user-visible benefit, and stable identifiers help anyone reading
git history.

Rationale: "Triage" is clinical-coded. With non-clinical staff in
the workflow, a neutral name is needed. "Inquiry" works for both
manual entry and the future ingestion/queue workflow.

### Roles & flags (DB schema)

`profiles` got two new columns:
- `is_admin BOOLEAN` — can manage users in their tenant
- `is_super_user BOOLEAN` — can configure category metadata, edit
  handoff template, grant/revoke super_user on others

The existing `role` column stays — values are still `'Clinical'`
or `'Non-Clinical'`. Admin and super_user are ORTHOGONAL to role:
a user can be `'Clinical' + admin`, `'Non-Clinical' + admin`,
either with super_user, etc. Admin/super_user are capabilities,
not job titles.

### Server-side role gates (kb.js)

Every mutating action on a clinical-tier row now checks the
caller's role:

- `update_urgency` → non-clinical refused on clinical rows
- `update_category` → non-clinical can edit `non_clinical_items`
  but cannot touch `clinical_category`. Tries to set category
  return 403, not silently dropped.
- `save_actual` → non-clinical refused on clinical rows (would
  otherwise pollute the Haiku correction analyzer)
- `delete_entry` → non-clinical refused on clinical rows
- `upvote` / `downvote` → non-clinical refused on clinical drafts
- `/reviews resolve` → non-clinical refused on reviews whose
  originating triage is clinical (would otherwise inject CSR
  judgments into the clinical KB)

All gates resolve via the new `resolveProfile(user)` helper, with
defensive helpers `isClinical()`, `isNonClinical()`, `isAdmin()`,
`isSuperUser()`. Under-gate is the worse failure mode (anyone
that isn't explicitly Clinical is treated as non-clinical for
gate purposes).

### Non-clinical handoff flow

When a non-clinical user analyzes a message and the AI flags
clinical content, they see a simplified handoff view instead of
the standard draft + controls. The view shows:

- Banner: "Clinical content detected. The nursing team has been
  notified."
- Patient message reference card
- (Dual triages only) the non-clinical portion they can act on —
  category, internal note, routed-to label
- Acknowledgment template card with Copy button. Template body
  comes from `companies.non_clinical_handoff_template` (per-tenant,
  super-user editable). Default: *"Thanks for reaching out! I've
  passed your message to our nursing team and they'll get back
  to you shortly."*
- Single "Mark as Escalated" button — flips
  `escalated_to_clinical=true`, sets `escalated_by` + `escalated_at`,
  records `non_clinical_handoff_used=true` and persists the
  acknowledgment as `actual_response_sent` so the row reflects
  what reached the patient.

The AI's clinical draft is NEVER shown to non-clinical staff —
not even hidden-but-collapsible. A CSR shouldn't be reading or
sending clinical advice; if the draft text is in their DOM they
could accidentally copy-paste it elsewhere.

### Category metadata (super-user configurable)

New `category_metadata` table, per-tenant, seeded for Big Easy:

| Category | is_clinical |
|---|---|
| Injection/Dosing | true |
| Side Effects | true |
| Severe Side Effects | true |
| Medication Management | true |
| Stall/Lack of Results | true |
| **General Inquiry** | **false** ← per your request |
| Billing/Payment | false |
| Shipment/Tracking | false |
| Account/Subscription | false |
| Refund Request | false |
| Complaint/Concern | false |

Super-user can flip `is_clinical` on any category via the Admin
panel. This drives the future Tasks/picker workflow's role-based
visibility.

### Admin panel (new tab)

Hidden by default; flipped on when `currentProfile.is_admin === true`.
Three sections:

- **Users** (admin): list every user in the tenant with email,
  name, role, admin flag, super-user flag. Edit role (Clinical /
  Non-Clinical), toggle admin flag, toggle super-user flag (only
  super-users see this control; only super-users can grant/revoke
  super_user). Self-demotion of super_user is blocked.
- **Categories** (super-user): list all `category_metadata` rows
  for the tenant. Toggle `is_clinical` and `is_active` per row.
- **Settings** (super-user): edit `non_clinical_handoff_template`.
  Capped at 4000 chars.

User emails come from `auth.users` via the Supabase Auth admin
REST endpoint (service-key only). Tenant-scoping: an admin can
only see users in their own `company_id`.

### New endpoints (kb.js)

- `GET /profile` — caller's own profile (role + flags). Used by
  initAuth to populate `currentProfile`.
- `GET /handoff-template` — caller's tenant handoff template.
- `GET /categories` — caller's tenant active categories.
- `GET /admin/users` — admin only.
- `POST /admin/users` action=`update_role` — admin only;
  super-user-only for `is_super_user` field.
- `GET /admin/categories` — super-user only.
- `POST /admin/categories` actions=`create`/`update` — super-user only.
- `GET /admin/settings` — super-user only.
- `POST /admin/settings` action=`update_handoff_template` — super-user only.

### New /history POST action

- `mark_escalated` — any role can call; flips
  `escalated_to_clinical`, sets `escalated_by` + `escalated_at`.
  When the caller is non-clinical, also sets
  `non_clinical_handoff_used=true` and (if `actual_response` in
  body) persists it as `actual_response_sent`.

### Frontend additions

- `resultIsClinical(d)` — client mirror of server's `rowIsClinical`.
- `loadHandoffTemplate()` / `getHandoffTemplate()` — prefetched
  cache for the non-clinical handoff text.
- `renderNonClinicalHandoff(d)` — simplified render path.
- `copyHandoffTemplate()` / `markEscalated()` — handoff actions.
- `loadAdminTab()` / `loadAdminUsers()` / `loadAdminCategories()`
  / `loadAdminSettings()` / `updateUserRole()` /
  `updateCategory()` / `saveHandoffTemplate()` — admin panel.
- `renderResults` gains a role-aware fork at the top.
- Standard render hides clinical category pills for non-clinical
  viewers — they can't set them anyway, no point dangling dead
  controls.

### Help & Guide updates

- "Roles & Escalation" section added (three FAQs)
- "Triage" terminology replaced with "Inquiry" throughout
- "Common Mistakes" updated to mention both delete paths and
  non-clinical's role-restricted delete

### Training-loop integrity

The gates ensure the learning loop stays clean:
- Non-clinical can't save `actual_response_sent` on clinical rows →
  Haiku correction analyzer never sees CSR edits to clinical content
- Non-clinical can't resolve clinical reviews → CSR answers never
  promote to clinical KB
- Non-clinical can't set clinical_category or severity → CSR
  judgments never enter the classification distribution

The KB stays clean by construction, not by trusting roles to
behave correctly.

### Tests

144 passing. No triage-lib changes; all additions are in kb.js
(server gates + admin endpoints), app.js (UI gates + admin tab),
and the new migration. CSS is additive only.

### Multi-tenant readiness

Everything is tenant-scoped by `company_id`. `category_metadata`,
`non_clinical_handoff_template`, role/flag columns all live
per-tenant. When tenant #2 onboards, they get their own seeded
categories and configurable handoff template; their admins manage
their own users without seeing Big Easy's.

---

## v0.3.24 — 2026-05-11

User report: with the page-size selector (v0.3.21) showing only
the first N rows, the only way to see older records was to bump
the size. Wanted prev/next arrows at top and bottom so staff can
page through without changing the window.

### Added — pagination

- **`← Prev` / `Next →` buttons + "Page X of Y" indicator** in
  bars rendered both above AND below the table. Top bar lets
  staff at the top of a list jump pages without scrolling down;
  bottom bar serves staff who scrolled through a long page.
- **"Showing M–N of Z" range label** in each bar so it's always
  clear which slice you're looking at.
- Prev/Next auto-disable at boundaries (`Page 1`, `Page N`). On
  filter changes that reduce row count below the current page,
  the page snaps to the last valid one rather than rendering
  blank.

### Implementation

- New `historyCurrentPage` module-level state (1-indexed).
- New `changeHistoryPage(delta)` handler — adjusts the page and
  calls `loadHistory({resetPage: false})` so the change persists.
- `loadHistory(opts)` gained a `resetPage` option (default
  `true`). Plain calls — filter/sort/size change, Load button —
  land on page 1. Internal callers that should preserve state
  (`deleteHistoryEntry` after a successful delete) pass
  `{resetPage: false}` so staff working through a cleanup batch
  stay on the page they were on.
- `buildHistoryPageBar(opts)` renders one bar; called twice from
  `loadHistory` (top + bottom). The bottom bar also embeds the
  page-size selector — putting it both top-and-bottom would be
  redundant with the one already in the `.history-controls`
  header block.
- Page is clamped to `[1, totalPages]` at render time, so any
  filter/sort/size change that invalidates the current page
  snaps to the nearest valid one.

### Removed

- `.history-page-footer` class — superseded by
  `.history-page-bar` with a `-bottom` modifier. The new bar
  includes the page-size selector AND the prev/next nav, so the
  standalone footer wasn't needed.

### Tests

144 passing. No triage-lib or endpoint changes.

---

## v0.3.23 — 2026-05-11

The Help & Guide drifted out of sync with the UI over the last
several releases. Surgical updates to bring it back into line.

### Updated — stale content

- **Quick Reference item #1** previously said "click Add Prior
  Context and paste the earlier thread there first." Prior Context
  is now a structured turn list (v0.3.17), not a textarea. Reworded
  to describe the speaker dropdown + text + Add turn flow with
  oldest-at-top, newest-at-bottom ordering.

- **"When do I use Add Prior Context?" FAQ** rewritten for the
  same reason. Also added the "why" — "without the earlier turns
  the AI is triaging a fragment and may re-explain things the
  patient already knows." That's the v0.3.16 bug, surfaced as the
  reason this matters.

- **"Common Mistakes" → "Entering the wrong thing"** previously
  pointed only to the Corrections tab for cleanup. Now mentions
  both paths: × on the Triage Queue row (v0.3.18) for whole-entry
  deletion, Corrections tab for note-only corrections.

### Added — new features that needed documentation

- **"How do I see what each row was about?"** new FAQ in Triage
  Queue & Stats. Describes the Message preview column and
  click-to-expand inline detail (v0.3.19).

- **"Can I delete a wrong entry?"** new FAQ. Describes the ×
  button, the three checkpoints (preview / expand / confirm
  dialog), and the fact that promoted KB entries survive a
  triage delete — important because that's a non-obvious
  guarantee.

### Intentionally not documented

- Page-size selector (v0.3.21). The dropdown labels
  ("Show 10/25/50/100/all") explain themselves; adding help
  copy would be over-documenting an obvious UI control.

### Tests

144 passing. Help-content edits only — no code paths touched.

---

## v0.3.22 — 2026-05-11

User report after v0.3.20 + v0.3.21: still has to trackpad-scroll
horizontally to reach the × delete button. v0.3.20's overflow-x:auto
made the table scrollable but didn't make it visible.

### Root cause

`.history-wrap{max-width:1100px;...}`. The History page was capped
at 1100px while the 11-column table needs ~1400px. The table
overflowed the wrap; on a typical desktop the × column was
off-screen and only accessible via horizontal scroll.

### Fixed

- **`.history-wrap` max-width: 1100px → 1600px**, matching the
  Triage tab's `max-width:1600px`. At this width the whole 11-
  column table fits without horizontal scrolling on any normal
  desktop.

### Why this is fine for narrower screens

- `.history-stats` uses `auto-fit, minmax(170px, 1fr)` so stat
  cards flow gracefully into the extra width without looking
  sparse.
- On laptops narrower than 1600px the wrap shrinks to viewport
  width automatically. `.data-table-wrap`'s `overflow-x:auto`
  (from v0.3.20) still works as a fallback there — table scrolls
  horizontally if it truly can't fit.

### Tests

144 passing. CSS-only.

---

## v0.3.21 — 2026-05-11

User report: with the History table showing up to 200 rows, the
page scrolls forever. Wanted 10/25/50 selectors at top AND bottom
so staff don't have to scroll back to the header to change the
window.

### Added

- **Page-size selector** in the History tab header controls.
  Options: Show 10 / 25 / 50 / 100 / All. Default is 25.
- **Mirror selector at the bottom of the table** so staff scrolling
  to the end of the list can change the window without scrolling
  back up. Both selects stay in sync via `onHistoryPageSizeChange`.
- **Record count in the table title and footer**: "Recent Triages
  — sorted newest first · showing 25 of 152 · click a row to
  expand". Tells staff at a glance how many rows they're seeing
  vs how many exist in the server's 200-row response window.

### Implementation

- `displayedRows = sortedRows.slice(0, pageSizeNum)`. Pure
  client-side slice — no server change, no extra fetch.
- `historyRowsById` still caches ALL `sortedRows` (not just the
  displayed slice). Changing the dropdown from "Show 25" to "Show
  all" re-renders without losing the cache; expanded rows still
  resolve their data.
- `onHistoryPageSizeChange(srcSelect)` mirrors the new value onto
  the other select via direct `.value =` assignment (which doesn't
  re-fire `onchange`, avoiding a sync loop), then calls
  `loadHistory()` to re-render. `loadHistory` re-fetches from
  `/history/all`, which is cheap (~200 rows, indexed query, no AI
  cost) and keeps the displayed window in sync with whatever's
  actually in the DB.

### Cost note (the question that came with this request)

There's no AI cost on the History view itself — the only Anthropic
spend happens during a triage. The fetch is one PostgREST query
(indexed, capped at 200), ~600KB transferred, ~50ms DOM render.
Cheap at any reasonable use volume. The page-size selector is a
UX win (faster perceived load, less scrolling), not a cost win.
When ingestion ramps and a tenant accumulates thousands of
triages, the 200-row server cap becomes the next limit to address
— pagination or date filters, not per-page caching.

### Aesthetic

- Footer uses the same `.history-filter` select styling as the
  header controls. Slight negative `margin-top:-8px` pulls it
  closer to the table without overlapping. Same rounded card
  border as `.data-table-wrap` above.

### Tests

144 passing. UI add (header select, footer, slice logic, sync
handler). No triage-lib or endpoint changes.

---

## v0.3.20 — 2026-05-11

User report: "Triage Queue — It looks like the delete function was
removed."

It wasn't removed — it was clipped. v0.3.19 added a Message preview
column which pushed the History table past its container width on
typical viewports, and the wrap's `overflow:hidden` (inherited from
the original styling for rounded corners) cut the rightmost cell —
the × delete button — off the screen entirely. Classic "didn't
test on a normal-width browser" miss.

### Fixed

- `.data-table-wrap` overflow changed from `hidden` to
  `overflow-x:auto;overflow-y:hidden`. Horizontal scroll lets staff
  reach the × button when the table exceeds the container width.
  Vertical stays hidden so the rounded corners still clip cleanly.

- `.message-preview` max-width reduced from 320px to 260px to
  reduce the likelihood of overflow in the first place. The
  truncation still cleanly fits ~80 chars; the column just doesn't
  hog as much horizontal real estate.

### Quality audit (v0.3.16 → v0.3.19)

Ran a focused audit across the last four releases — tenant scoping
on the new delete endpoint, HTML injection on the new inline
onclick handlers, dead code from the priorInput → priorTurns swap,
historyRowsById cache staleness, prior-turn serialization with
embedded quotes, and eval wrapper drift vs production. All six
came back clean. No bugs or security issues introduced by v0.3.16
through v0.3.19.

### Tests

144 passing. CSS-only fix.

---

## v0.3.19 — 2026-05-11

User report on v0.3.18: "I am unable to see what content / entry
was the one I want to delete. This is a huge issue because people
could randomly delete entries, especially incorrect ones as there
is no context."

v0.3.18 shipped delete but didn't ship the context staff need to
decide WHICH row to delete. Fair criticism — the row only showed
score, date, staff, category, urgency. Nothing about WHAT the
patient said.

### Added — three checkpoints of context before delete

1. **"Message" column** in the History table previews ~80 chars
   of `patient_message`. Whitespace is collapsed so newlines don't
   break the single-line preview. Empty messages render as a
   muted `(empty)`. Visible in every row, zero interaction
   required — solves the "is this the one?" question at a glance
   for the common case.

2. **Click any row to expand inline.** Click the row body (not
   the × button) and a detail panel slides in below showing:
   - Full patient message
   - AI draft response
   - Sent-to-patient text (only if it differs from the draft —
     verbatim sends would just duplicate)
   - Internal note (for non-clinical handoffs)
   - Follow-up questions (if any)
   - Correction note (if staff left one)

   Click again to collapse. The cached row data lives in
   `historyRowsById` (populated by `loadHistory`) so expand is
   instant — no per-row refetch.

3. **Delete-confirm dialog now quotes the preview back to the
   user** before they commit. Three checkpoints total: column
   preview → optional row expand → confirm dialog with preview.

### Changed

- `deleteHistoryEntry(id)` looks up the row in `historyRowsById`
  and includes a 120-char preview in the confirm message.
- The × button now calls `event.stopPropagation()` so clicking
  delete doesn't also toggle the row's expand state — those are
  two separate intents.
- The data table got a `data-table-clickable` modifier class for
  the cursor:pointer + hover styling on history rows, without
  affecting other tables (per-staff breakdown above).

### Tests

144 passing. UI restructure + helpers (`previewPatientMessage`,
`buildHistoryDetailHtml`, `toggleHistoryRowDetail`); no
triage-lib or pure-helper changes.

---

## v0.3.18 — 2026-05-11

User report: "I entered the wrong messages into the Triage area. I
entered my response into the most recent message 'Latest Reply' and
so it messed up the response. I don't want the AI to learn
something whacky in regards to it. I'd rather not manually enter
the del query into Supabase every time."

Until now the only way to delete a bad entry was opening Supabase
and running DELETE manually. Friction that meant most bad rows just
sat in the table, polluting averages and corrupting the learning
loop.

### Added

- **× delete button on each row of the History table.** Muted gray
  by default; turns red on hover. Confirms before deleting with a
  dialog that's explicit about what gets removed and what survives.

- **`delete_entry` action on `/history` POST** (`kb.js`). Hard-deletes
  the `query_history` row, tenant-scoped via
  `id=eq.<id>&company_id=eq.<callers>` so a malicious caller can't
  delete another tenant's rows by passing a foreign id. Returns 404
  if zero rows match (PostgREST normally returns 200 with `[]` for
  empty-result deletes — easy to misread as success).

- **FK cleanup for `review_requests`.** `review_requests.triage_id`
  references `query_history.id` without `ON DELETE CASCADE` (see
  `migrations/0001_baseline.sql`), so deleting the parent first
  would FK-violate. The handler deletes any attached `review_requests`
  rows before deleting the triage. Tenant-scoped on the review's own
  `company_id` to prevent cross-tenant nukes via a foreign
  `triage_id`.

- **`deleteHistoryEntry(id)` on the frontend.** Calls `/history`
  POST with the new action, clears `currentHistoryId` if the
  deleted row was the one currently displayed on the Triage tab
  (so subsequent edits/upvotes don't 404), then reloads the
  history list.

### Intentionally NOT deleted

- **KB entries already promoted from the triage.** They live in
  `kb_entries` as separate rows — the lesson the AI learned
  survives the deletion of its origin triage. Staff manage KB
  entries from the KB tab.

### Tests

144 passing. The change is a UI add + new endpoint action; no
triage-lib or pure-helper changes.

---

## v0.3.17 — 2026-05-11

User feedback after v0.3.16 landed: the prior-context feature was
now actually being read by the AI, but the free-form textarea
required staff to remember to type
`Patient: "..."` / `Nurse: "..."` formatting themselves. Staff
won't reliably do that ("teaching people to use my formatting
probably won't work — it's more labor intensive and people won't
want to use it"), so the structure had to move into the UI.

### Changed

- **Replaced the free-form Prior Context textarea with a stack of
  structured turn rows.** Each row is: speaker dropdown
  (`Patient` / `Nurse` / `Other`) + text field + remove (×) button.
  A "+ Add turn" button appends new rows. The panel opens with one
  empty row pre-populated, so the feature is discoverable
  immediately.

- **Order is chronological — oldest turn at the top, newest reply
  at the bottom.** This matches how Intercom/email threads read
  and mirrors the AI's top-to-bottom processing of the prior
  block. The Latest Patient Message textarea sits below the prior
  block, completing the sequence.

- **`serializePriorTurns()` walks rows top-to-bottom and produces
  the same `Patient: "..."` / `Nurse: "..."` transcript the AI was
  already parsing happily in v0.3.16.** Empty rows are skipped, so
  half-filled lists still produce a clean transcript. If every row
  is empty, the function returns `''` and `runTriage` takes the
  no-prior path. No change to the wrapper wording or to
  `BASE_PROMPT_TEMPLATE` — v0.3.16's prompt-side fix is preserved.

- **`togglePrior` close behavior**: the old "clear the textarea on
  close" intent now becomes "drop all rows, leave one empty
  starter row." Closing the panel never deletes the feature from
  view.

- **Removing the last remaining row auto-restores an empty one**
  via `removePriorTurn`. Staff can't accidentally hide the feature
  by deleting every row.

### Why this matters beyond manual triage

The same serialization path will serve channel adapters
(Intercom, email, Healthie) once those land. When an inbound
thread arrives with N prior turns already structured, those
turns can populate the same row list on the manual editor — or
go straight through `serializePriorTurns`'s equivalent on the
server. One transcript format, two ingestion paths.

### Cleanup

- Removed the now-dead `.prior-input` CSS rule (no HTML element
  used it after the swap). Per `AGENTS.md` #15.

### Tests

144 passing. No triage-lib or pure-helper changes; this is a UI
restructure plus serialization helper.

---

## v0.3.16 — 2026-05-11

User report: ran a triage, then re-ran the same triage with prior
context added, and the output was indistinguishable. The AI
wasn't factoring the prior context in.

### Root cause

The user-content wrapper around prior context said:
> *"PRIOR CONVERSATION CONTEXT (earlier thread — for background
> only, do not respond to this directly)"*

The phrase **"do not respond to this directly"** was being
interpreted by the model as *"ignore this content entirely"* — the
opposite of what we wanted. Compounding it, `BASE_PROMPT_TEMPLATE`
said nothing about prior-context handling. The AI had no
instruction to integrate prior facts into its response, so it
defaulted to producing a fresh first-contact reply every time.

### Fixed

- **Reworded the user-content wrapper** in `runTriage` (and the
  matching wrapper in `eval/run.js` so the eval still mirrors
  production). The new wording tells the AI explicitly:
  - the patient already received everything in the prior block —
    don't repeat education they already got
  - reference specific facts they shared (dose, TDEE, weight
    goals, symptom timing, prior side effects)
  - the LATEST message is what they're asking now; tailor the
    reply to that, but draw on the prior conversation when
    relevant

- **Added a `PRIOR CONVERSATION HANDLING` clause to the
  `draft_response` instructions in `BASE_PROMPT_TEMPLATE`.** The
  model is now told twice — once in the structural prompt, once
  in the user content — that prior context should be integrated,
  not ignored. The clause specifies "integrate specific facts so
  it reads as a continuation of the same conversation, not a
  fresh first-contact reply."

- **Added a `console.log` in `runTriage`** that prints whether
  prior context was sent and how many characters. Lets staff
  verify in dev tools that the prior context they typed actually
  went through to the proxy, which rules out the second
  hypothesis (typed in wrong field, panel state issue) without
  needing to inspect the network tab.

### Eval baseline shift

`BASE_PROMPT_TEMPLATE` changed, so the next eval run will produce
a new `prompt_version` hash (was `a615b5ad`). That's expected and
correct — it's the audit trail working as designed. Re-run
`npm run eval -- --endpoint <url> --token <jwt>` to capture the
new baseline. Quality on the 7 existing cases should be
unchanged or slightly better; the prior-context handling
addition is additive (none of the 7 cases include prior
context).

### Tests

144 passing.

### What you should see

Re-run your test scenario: same triage, run once without prior
context, run a second time with the prior context added.

The second response should now reference specifics from your
prior context (TDEE, prior questions, anything established
earlier). If it still reads identical to the first response,
that means the prior wasn't sent — open browser dev tools,
console tab, look for the `runTriage:` log line. It will say
`no prior context` if the priorInput textarea was empty when
you clicked Run Triage, or `prior context = N chars` if it was
sent (in which case the issue would be deeper).

---

## v0.3.15 — 2026-05-10

User report (with screenshot): selected a non-clinical category,
saved it, but the Category column in the Triage Queue showed
empty. Data was saved correctly to `non_clinical_items` (the
jsonb array); the display logic just ignored it.

### Fixed (display bug, no data corruption)

- **Queue table's Category column** only read `clinical_category`
  and didn't look at `non_clinical_items` at all. Non-clinical-
  only triages appeared with an empty Category cell.
- **Corrections list's category label** (in KB → Corrections
  tab) had the same bug — same fix.

Both now use a shared `formatCategoryDisplay(row)` helper in
`triage-lib.js`. Output shapes:
- Clinical only: `"Side Effects"`
- Non-clinical only: `"Billing/Payment"`
- Dual: `"Side Effects · Billing/Payment"`
- Multiple non-clinical: `"Billing/Payment, Shipment/Tracking"`

The middle-dot separator distinguishes the clinical vs
non-clinical halves of a dual; commas separate items within the
non-clinical list.

### Added

- `formatCategoryDisplay(row)` helper in `data/triage-lib.js` — pure,
  testable, handles null/empty inputs defensively.
- 7 new tests covering each output shape + null/legacy-row
  handling (e.g., non-array `non_clinical_items` from
  pre-v0.3.1 data).

### Tests

144 passing (was 137).

### What you'll see after the deploy

Your row from the screenshot — Brad, May 10 8:12 PM, score 3,
Non-Clinical priority — should now show the actual non-clinical
category you selected in the Category column. The data was
already there; only the rendering was missing it.

---

## v0.3.14 — 2026-05-10

Twelfth-pass audit. User asked whether more checks are warranted
given the recent pattern of bugs from prior refactors. Applied
the new AGENTS.md rule #15 retroactively — exhaustive grep for
every variable/function symbol I've removed in past commits.

### Audit results

- **All onclick / onchange / oninput handlers in `index.html`
  resolve to functions defined in `app.js`** — no orphan
  handlers.
- **All `getElementById('x')` calls in `app.js`** reference IDs
  either defined in `index.html` or dynamically created within
  `app.js`'s `innerHTML` blocks. No dangling lookups.
- **Past-refactor orphan search** (the v0.3.13 `isClinical`
  class of bug): every previously-removed symbol — `getKBPrompt`,
  `kbCacheKey`, `triageHeaders`, `triageToken`, `analyzeHeaders`,
  `analyzeToken`, `isClinical`, `hasSideEffect` — has zero
  remaining code references. Only historical comments in the
  v0.3.13 CHANGELOG explanation contain the names, which is
  intentional.
- **Eval cases use current enum values** — no leftover
  pre-v0.3.0 categories like "GI side effects" or
  "Urgent-escalate."

### Fixed (schema drift)

- **`review_requests.created_by` declared in 0001_baseline.sql
  but missing in production.** Discovered when 0008's first
  attempt failed at the review_requests UPDATE. Migration 0009
  adds the column with `add column if not exists` (idempotent)
  and backfills historical rows via the triage_id chain
  (`rr.triage_id → query_history.user_id`).

  Application impact: silent. The application has been writing
  `created_by: user.id` on every review insert since the
  codebase existed; PostgREST has been dropping the field
  because Supabase tolerates unknown columns. Functionally
  invisible because nothing reads the column today. But the
  fallback PATCH WHERE clauses in `/reviews resolve` and
  `/reviews dismiss` reference `created_by` when
  `callerCompanyId` is null — those clauses would 400 if they
  ever fired. They don't fire in production today because every
  profile has a company_id after 0008. Closing the drift
  removes a latent failure mode.

### Recommended: run migration 0009 in Supabase

```sql
-- one-line column addition + backfill
\i migrations/0009_review_requests_created_by.sql
```

Or paste the file's contents into the SQL editor. Output will
show how many historical rows got their `created_by` populated
via the triage chain.

### Audit method (this pass)

Applied AGENTS.md #15 retroactively. The audit started with:

```bash
# 1. Every onclick handler in HTML resolves to a function in JS
grep -nE 'on(click|change|input)="[a-zA-Z_]+\(' index.html | ...

# 2. Every getElementById in JS either exists in HTML or in JS innerHTML
grep -oE "getElementById\('([^']+)'\)" app.js ...

# 3. Every removed symbol from past refactors has zero code refs
for sym in <removed-symbols>; do grep -nE "\\b$sym\\b" ...; done

# 4. Eval cases match current enum values
grep -h "clinical_category" eval/cases/*.json
```

All four came back clean except the known `created_by` drift,
which 0009 now reconciles.

### Tests

137 passing. No new tests — schema migration only.

---

## v0.3.13 — 2026-05-10

Fixes a regression introduced in v0.3.6: `renderResults` was
referencing `isClinical`, a variable that was removed in v0.3.6
when the inline classification logic was replaced with the shared
`taskShape`/`priorityTier` helpers. A reference to it lingered on
the severity-badge condition. At runtime this surfaced as
`ReferenceError: isClinical is not defined`, which then propagated
up through `runTriage`'s catch block as a generic "Triage could
not complete" message.

User would have seen this as: paste a patient message, click
Run Triage, brief loading spinner, then an amber error panel.
No triage data lost — the failure was purely in rendering, after
the AI returned a valid response but before `saveHistoryRecord`
could run.

Replaced the dangling `hasSideEffect && isClinical` check with a
`isRealSE` derived from `priorityTier(d)` — true when the tier
is one of `severe-se | moderate-se | mild-se`. Keeps the
severity badge in sync with the queue's tier label and removes
the duplicate classification logic.

### Audit note

This is the second variable-removed-but-not-everywhere-replaced
bug from the v0.3.6 refactor (the first was the corrupted
saveCategoryTags compound string). Each refactor that replaces a
local variable with a shared helper needs an exhaustive grep for
the variable name in the same commit, not just the obvious uses.
That's the kind of thing I should have caught with a pre-commit
`grep -n` instead of relying on tests — the affected code path
isn't exercised by the pure-Node test harness because
`renderResults` is DOM-bound.

### Tests

137 passing.

---

## v0.3.12 — 2026-05-10

Fixes session-expiry — user hit `API /history returned 401:
Authentication required` after working past the JWT's 1-hour
expiry. The bug was always there; v0.3.8's strict-error api()
just made it visible. The frontend was never refreshing the
access_token despite storing the refresh_token at login.

### Added

- **`refreshSupabaseToken()`** in `app.js`. Uses the stored
  refresh_token to mint a new access_token (and rotated
  refresh_token) from Supabase Auth. Serialized via a shared
  in-flight promise so concurrent calls don't race the
  refresh-token rotation and dead-token each other.
- **`authFetch(url, opts)`** wrapper. Auto-attaches the Bearer
  token, and on 401 transparently refreshes + retries once. If
  the refresh itself fails (refresh_token expired, or user is
  truly logged out), shows a "Session expired — redirecting to
  login..." toast and bounces to `/login.html`.
- **`SUPA_URL` and `SUPA_KEY` constants** in app.js, mirroring
  login.html. The anon key is intentionally public — that's
  Supabase by design. Comment in code calls out the
  "if you rotate, update both files" coupling.

### Changed

- **`api()` routes through `authFetch`** instead of doing its
  own raw fetch with token plumbing. All `/.netlify/functions/kb/*`
  calls (KB load/save, history list/save/patch, reviews list/
  resolve/dismiss, /analyze) inherit auto-refresh.
- **`runTriage`'s `/triage` call** uses authFetch. A stale
  session no longer breaks mid-triage.
- **`submitCorrection`'s `/analyze` call** uses authFetch. Same
  root cause as the missing-Auth bug from earlier today; this
  also covers the expiry-during-correction case.
- **`initAuth`'s `/auth/profile` call** uses authFetch. When the
  user opens the app after >1 hour away, the silent refresh
  keeps them in instead of bouncing to magic-link.

### Behavior

- **Inside the 1-hour active window**: zero change. The current
  token works on every call.
- **After 1 hour**: first 401 triggers a refresh. The refresh
  call adds ~100-200ms latency to that one API call. Subsequent
  calls use the new token without delay.
- **After ~7 days inactive** (refresh_token expired): refresh
  fails. Toast + redirect to login. User does the magic-link
  flow again, fresh tokens.
- **Concurrent calls all 401-ing**: they share the same in-flight
  refresh promise. Only one refresh happens; everyone retries
  with the new token. No token-rotation race.

### Tests

137 passing. Auth-flow logic is fetch/localStorage-bound and not
testable in the current pure-Node harness.

---

## v0.3.11 — 2026-05-10

Tiny UX fix on the Triage Queue surfaced by real use: the queue was
priority-sorted (most-urgent-first), which is the right behavior
for a live queue Phase 3 will bring, but is the wrong default for
"what did I do today?" — today's lower-priority rows ended up
buried below older high-urgency rows.

### Added

- **Sort dropdown on the Triage Queue page.** Two options:
  - **Newest first** (default, new behavior) — pure date sort,
    descending. Today's triages at the top, scrolling down goes
    further back in time.
  - **Priority first** — preserves the older queue-style sort
    (highest urgency_score first, then newest within a tier).
    Useful when the queue UI lands in Phase 3 and the surface
    actually is a live queue.

### Changed

- **Removed the 100-row display cap on the queue table.** Now
  shows every row the server returns (up to /history/all's 200-row
  server-side limit), so the user can scroll down to the very
  first recorded triage. Server-side limit stays at 200; Phase 3's
  queue UI will replace this surface entirely.
- Queue-table title updates to reflect the current sort
  ("sorted newest first" vs "sorted by priority") so the user
  always knows which order they're looking at.

### Not changed (intentionally)

- Legacy data left as-is. The polluted older rows (old AI enum
  values, compound categories from the pre-v0.3.1 saveCategoryTags
  bug) are NOT corrupting the AI — the AI doesn't read
  query_history; only BASE_PROMPT + kb_entries. The legacy rows
  are purely historical record. They affect some aggregations
  (Top Category counts) but don't cause hallucinations. User
  explicitly opted to keep them.

### Tests

137 passing. No new tests — sort logic is DOM-bound and not
testable in the current pure-Node harness.

---

## v0.3.10 — 2026-05-10

First real channel adapter foundation. Big Easy's owner indicated
they want to use Intercom for their customer service workflow, so
Intercom-first (ahead of Bask) is the right priority — bigger
documentation surface, broader applicability across future tenants
in any vertical.

This release is **inbound webhook only**. Patient messages from
Intercom now land in `query_history` as pending rows with
`source_channel='intercom'`. The worker (still stubbed) will pick
them up and run triage when wired. Outbound (posting staff-approved
replies back to Intercom conversations) is deferred until the worker
and staff queue UI are real — that's Phase 3 territory.

### Added

- **`netlify/functions/intercom.js`** — the channel adapter file.
  - HMAC signature verification (SHA-1 and SHA-256), timing-safe
    comparison.
  - HTML strip that preserves paragraph breaks for the AI's
    classification context.
  - Handles two event topics: `conversation.user.created` and
    `conversation.user.replied`. Other topics are acknowledged
    with 200 + `ignored: true` so Intercom doesn't retry events
    we deliberately skip.
  - Idempotency via `external_id = "intercom:<conv_id>:<part_id>"`
    so webhook retries dedup via the existing unique index on
    `query_history` AND replies on the same conversation don't
    collide.
  - Honest success/failure response on insert (PostgREST status
    propagates) so Intercom retries are safe.
  - Tenant identification via `INTERCOM_TENANT_COMPANY_ID` env
    var (single-tenant trial). Phase 4 multi-tenant routing will
    switch to URL-keyed tenants.
  - Pure helpers (`verifyIntercomSignature`, `stripHtml`,
    `extractMessage`) are exported and unit-tested.

- **`tests/intercom.test.js`** — 28 new tests covering signature
  verification (valid, tampered, malformed, wrong-secret,
  hex-length-mismatch), HTML stripping (paragraph breaks, list
  items, entities, realistic Intercom payloads), and payload
  extraction (new conversations, replies-with-admin-parts,
  unsupported topics, missing/null data). 137 passing total now.

### Env vars (new)

- `INTERCOM_WEBHOOK_SECRET` — shared HMAC secret from Intercom's
  webhook configuration.
- `INTERCOM_TENANT_COMPANY_ID` — UUID of the tenant Intercom
  webhooks attribute messages to. Single-tenant only; Phase 4
  switches to URL-keyed routing.
- `INTERCOM_ACCESS_TOKEN` (not used yet) — Intercom API token for
  the outbound path when worker is wired.
- `INTERCOM_ADMIN_ID` (not used yet) — which Intercom admin to
  record as sending the staff-approved reply.

### Setup (when you're ready to enable inbound)

1. In Intercom: Settings → Developer → Webhooks. Create a webhook
   subscribed to `Conversation user created` and
   `Conversation user replied`. URL: `https://<your-relai-domain>/.netlify/functions/intercom`.
2. Copy the webhook signing secret into `INTERCOM_WEBHOOK_SECRET`
   in Netlify env vars.
3. Set `INTERCOM_TENANT_COMPANY_ID` to Big Easy's `companies.id`
   (verify via `select id, name from public.companies;`).
4. Save env vars; Netlify will redeploy. Send a test message in
   Intercom — it should land in `query_history` with
   `source_channel='intercom'` and `status='pending'`.

Until worker.js does real triage, those pending rows just queue.
The staff workflow for them (queue UI, claim, send back via
outbound) is Phase 3 work.

### Audit method

Built defensively from the start — applied the AGENTS.md
checklist:
- Auth: HMAC signature on every request (not a JWT auth
  endpoint, but the equivalent for webhooks).
- Cap / model gate: N/A (no AI call from this adapter).
- Trust boundary: incoming Intercom payload is parsed defensively
  with type checks and null guards on every field.
- Honest success: insert failure returns 5xx so Intercom retries.
- Idempotency: external_id format prevents double-processing on
  retries.
- Tenant scoping: company_id forced from env var, not body.
- Empty / unsupported payloads: return 200 quietly, no crash.

### Tests

137 passing (was 113). 24 new tests for Intercom helpers + 4 for
extended normalization from v0.3.9.

---

## v0.3.9 — 2026-05-10

Tenth-pass audit. User's framing: don't go live with webhooks until
the learning loop itself is bulletproof. Real-time ingest at scale
amplifies any silent corruption in the loop — every webhook'd
triage compounds the same bug.

This pass hunted the learning-loop specifically: every link from
review-create → resolve → KB-insert → next-triage-uses-new-KB.
Found four real bugs in that chain, all silent, all corrupting
data quality over time.

### Fixed (learning-loop integrity)

- **KB didn't auto-refresh after a review promoted to KB.** When
  staff resolved a `kb_gap`/`protocol` review, the backend
  correctly inserted a new `kb_entries` row, but the frontend's
  in-memory `kb` global was never reloaded — only
  `invalidateKBCache()` was called, which resets the cached
  string but not the underlying data. Result: the **next triage
  sent stale KB to the AI**. The new knowledge didn't reach the
  AI until staff manually opened the KB tab and triggered a
  reload. **Multi-day learning latency on the very loop we're
  trying to close.** Now `submitReview` calls
  `loadKBFromServer()` after a successful KB promotion.

- **"Promotion failed" was silently shown as "confirmation."** If
  the kb_entries INSERT errored (network blip, schema constraint,
  RLS misconfiguration), `promotedSection` was null and
  `appliedTo` fell through to `"confirmation"`. The user saw
  *"✓ Saved — confirms existing logic"* and walked away thinking
  the AI had learned. **No data actually reached the KB.** The
  AI would keep producing the same gap, staff would keep
  answering it, the loop never closed. Now distinguishes a third
  outcome `'kb_failed'` with an amber warning telling staff to
  re-try or add the entry manually.

- **Double-resolve wasn't blocked.** The `/reviews POST resolve`
  handler didn't check the review's current status. A staff
  double-clicking or two tabs both submitting would **promote a
  duplicate kb_entries row**, double-write the audit log, and
  return success. The AI's KB grows fake redundancy that
  pollutes future triages. Now returns 409 Conflict if the
  review is already `resolved` or `dismissed`.

- **AI output normalization missed `routed_to` and
  `review_request.context`.** v0.3.5 normalized urgency, level,
  and clinical_category, but two fields slipped through. The
  most consequential: `review_request.context` is checked via
  strict equality (`ctx === "kb_gap"`) in the resolve handler
  to decide on KB promotion. If the AI ever returned `'KB_gap'`
  (uppercase) or `'kbgap'` (no underscore), the strict check
  missed, no promotion ran, the staff's answer reached the
  review row but **never reached the KB**. Silent learning-
  loop failure. Now both fields go through `normalizeEnum` —
  `routed_to` to one of the 5 canonical departments,
  `review_request.context` to one of 5 canonical contexts. 4
  new tests.

### Audit method

User's concern: every pass produces critical findings; going live
with webhooks would amplify any silent corruption catastrophically.
The audit method this pass: **trace every link of the active
learning loop and ask, at each step, what happens when it
silently fails?**

1. Review created → row exists? Yes, but if the request gets
   401'd (already hardened in v0.3.4), nothing fails-fast.
2. Staff sees pending review → /reviews GET works post-v0.3.4.
3. Staff submits answer → /reviews POST resolve. Found:
   double-resolve not blocked.
4. Handler decides to promote → strict equality on `ctx`. Found:
   case-mismatch silently skips promotion.
5. promoteReviewToKB inserts kb_entries → could fail. Found:
   failure silently reported as `confirmation`.
6. kb_entries inserted → does the front-end see it on next triage?
   Found: in-memory `kb` is stale, next triage sends old KB.

Each link of the loop had a silent-failure mode. All four fixed.

### Tests

113 passing (was 109). 4 new tests cover routed_to + context
normalization including the canonicalization-makes-strict-
equality-work pattern that's foundational for the resolve
handler's promotion logic.

### What's left

The five raw-fetch callers (verified in v0.3.8) are all auth'd.
The api() helper throws on non-2xx (v0.3.8). The learning loop is
now hardened end-to-end (this pass). The next bug categories
should genuinely be real-data corner cases — staff doing
unexpected things, AI producing outputs my eval doesn't cover, or
schema drift I haven't hit yet (the `created_by` situation from
0008 was one of these).

Webhook ingest specifically: ingest.js validates API key, dedupes
by external_id (unique constraint as backstop), returns honest
success/failure, and forces company_id from the API key row. It
should be safe to enable webhooks against this code. Validate
the live flow end-to-end with a test webhook before opening it
to Bask production traffic.

---

## v0.3.8 — 2026-05-10

Ninth-pass audit. User caught a real bug (the /analyze missing-auth)
that prior audits should have surfaced; this pass addressed the
underlying *class* of bug rather than just patching the one
instance. The pattern was "defensive fallback that masks the real
error" — the kind of code that looks safe but actually hides
problems from both users and audits.

### Fixed (defensive-fallbacks-that-mask-errors class)

- **`api()` helper silently swallowed HTTP errors.** The previous
  implementation was:
  ```js
  var r = await fetch(...);
  return r.json().catch(function(){return{};});
  ```
  Three different failure modes were being collapsed into "looks
  like a successful response with an empty/error-shaped body":
  - Server returned 4xx/5xx with `{error: "..."}` body → callers
    that didn't inspect the response shape showed "Saved" toasts
    while the operation actually failed.
  - Server returned non-JSON (HTML error page, empty body, network-
    layer 502) → callers saw `{}` and treated it as success.
  - Network blip during fetch → only the fetch throw propagated;
    no context on what endpoint or operation failed.

  This was the same root pattern as the v0.3.5 `/triage` auth bug
  and the v0.3.8 `/analyze` auth bug: defensive coding that
  prevents crashes but doesn't surface that something went wrong.

  Rewritten to throw a structured `Error` on any non-2xx response,
  with `.status` and `.body` attached. Every caller is already
  wrapped in try/catch (verified this pass), so their existing
  error-handling UI now actually fires when something fails
  instead of looking like a no-op success. Parse failures with
  error status throw with the raw body included. Network errors
  are wrapped with the endpoint name for diagnostics.

### Fixed (eval harness UX)

- **Eval's auth-failure message hardcoded "check ANTHROPIC_API_KEY"
  even when running in `--endpoint` mode.** When the harness hit
  401 against the auth-gated deployed proxy, the abort message
  pointed at the wrong env var. Now branches by mode: direct-
  Anthropic auth failures still mention the API key; endpoint-mode
  failures explain how to grab a session JWT from localStorage and
  pass it as `--token`.

### Audit method

The user pointed out, correctly, that the missed /analyze auth
bug is exactly what audits are supposed to catch. The root failure
of the audit method was checking *server-side state* ("does
/analyze require auth?") without asking the *inverse* ("does every
fetch to /analyze send Auth?"). That's now codified as rule #14 in
AGENTS.md.

This pass: looked for the class of bug rather than the instance.
The `api()` helper was the broader version of the same pattern —
defensive coding that masks real errors. Even if the /analyze
specific auth bug is now fixed, similar "looks-like-success-
actually-failed" cases were possible across every other endpoint
because the helper itself was the masking layer.

### Tests

109 passing.

### Real-data cleanup (optional)

For triages created between v0.3.4 and v0.3.7, edited corrections
have `correction_note = '(empty learning note from analyzer)'`
(the masked-auth-failure fallback). Real edits from now on will
produce real learning notes. To NULL out the placeholder strings:

```sql
update public.query_history
set correction_note = null
where correction_note = '(empty learning note from analyzer)';
```

The corresponding `actual_response_sent` and `edit_distance` on
those rows are valid — only the AI-summary was missing.

---

## v0.3.7 — 2026-05-10

Eighth-pass follow-up to v0.3.6 — testing the new asymmetry surface
that v0.3.6's tenant-scoped writes might have created. Found one
genuine downstream issue.

### Fixed

- **`patchById` returned 200 with empty array on cross-tenant patch
  attempts.** The new tenant-scoped WHERE clause from v0.3.6
  (`id=eq.<bodyid>&company_id=eq.<theirs>`) correctly matches zero
  rows when a caller passes another tenant's row id. PostgREST
  with `Prefer: return=representation` returns 200 with `[]`,
  which a naive caller would read as "patch succeeded." Same
  shape ambiguity for legitimate "id not found" failures. Now
  surfaces 0-rows-affected as 404 explicitly, distinguishing
  silent success from silent failure.

### Audit method

This was a **deliberate test of the v0.3.6 fixes' downstream
effects**. The pattern from previous passes was that each fix
created a new asymmetry that became the next round's bug. This
pass asked: "does v0.3.6's write-path tenant scoping have any
asymmetric failure modes?" — and the answer was yes (the empty-
array-on-no-match silent success).

Tests: 109 passing.

---

## v0.3.6 — 2026-05-10

Seventh-pass audit on Juno. Focused specifically on **integration
paths between fixes from previous passes** — the user's concern was
that each pass introduces changes without validating their downstream
effects. Found 5 more critical-class bugs, several of them caused by
*combinations* of earlier fixes that left silent gaps.

### Fixed (cross-tenant write vulnerabilities)

The v0.3.4 RLS-independence work made reads service-key + explicit
company_id-scoped. Writes were not similarly hardened. With the
read path locked down but write paths still trusting client-
supplied tenant identifiers, a malicious user with a valid session
could:

- **Insert query_history rows in another tenant's namespace** (the
  `/history POST` default insert path forwarded the body to
  PostgREST verbatim — `user_id` and `company_id` from the body
  were trusted). Now both fields are forced from the verified JWT.
- **PATCH query_history rows in any tenant** by passing their id
  (`patchById` had `id=eq.<bodyid>` with no tenant clause). Now
  tenant-scoped: `id=eq.<bodyid>&company_id=eq.<theirs>`. A
  cross-tenant id matches zero rows.
- **Resolve / dismiss review_requests in any tenant** the same way
  (no tenant check on `id=eq.<bodyid>`). Now both verifies the
  looked-up review's `company_id` matches the caller's *and*
  tenant-scopes the PATCH WHERE.
- **Create review_requests with arbitrary company_id** (the
  `create` action trusted `body.company_id`). Now forced from the
  verified JWT.

### Fixed (data orphaning)

- **`buildEntries` was producing KB save payloads without
  `company_id`.** The /kb POST handler tenant-scopes the snapshot
  and DELETE by company_id (correctly), but the new entries
  inserted afterward had no `company_id` set — so they landed in
  the DB with `company_id=NULL`. The next /kb GET (which now
  filters by `company_id=eq.<theirs>` per v0.3.4) would return
  zero rows. **Frontend would interpret as empty, re-seed, and
  the cycle would silently keep producing orphaned rows.**
  Production was masked because the existing KB rows had
  `company_id` set via dashboard / earlier pre-bug saves; every
  new save was orphaning entries. Now buildEntries includes
  company_id, and the backend force-overwrites it from the JWT
  for defense-in-depth (so a malicious client can't write KB
  entries into another tenant's space).

### Fixed (user provisioning gap)

- **Auto-create profile in `auth.js` didn't set `company_id`.**
  The handler creates a profile row when a user signs in for
  the first time and no row exists. The created row had no
  `company_id`, meaning every triage that user produced going
  forward would have `company_id = NULL` (because frontend's
  `getCompanyId()` reads from the profile). Their data would be
  invisible to all the company-scoped aggregations introduced
  in v0.3.4.

  Fix: in single-tenant trial (exactly one row in `companies`),
  auto-attach the new profile to that company. In multi-tenant
  scenarios (multiple companies), leave `company_id` null and
  require explicit invitation via `/auth/invite` — the safer
  default once tenant boundaries matter.

### Cleaned up

- `readHeaders()` is no longer used for any PostgREST read in
  `kb.js` after v0.3.4. The only remaining caller is
  `verifyUser`, which calls Supabase Auth's `/auth/v1/user` —
  not PostgREST. Updated the function comment to reflect this
  so future readers don't think it's still part of the read
  path.

### Audit method (pass 7)

The user's pushback after v0.3.5 was that the cumulative editing
across passes might have introduced regressions. This pass tested
that hypothesis explicitly:

1. **Re-read each heavily-edited file end-to-end.** `kb.js` had
   been edited in 6 of 7 passes, totaling ~700 lines now. The
   buildEntries / /kb POST orphaning bug surfaced from
   re-reading the data flow as a single coherent path instead
   of file-by-file.
2. **Trace data round-trips: write → read.** Does the row I just
   wrote get found by the read I'd run next? That's how the
   buildEntries-no-company_id orphaning surfaced.
3. **Trust boundaries on every write endpoint, not just paid-API
   ones.** v0.3.4 hardened the read path but writes still trusted
   client-supplied tenant identifiers. Walked every write
   endpoint and verified `user_id` / `company_id` come from the
   JWT, not the body.
4. **First-run paths.** The auto-create-profile flow in auth.js
   surfaced from explicitly tracing "what happens the first time
   a new user signs in?"

### Tests

109 passing, no new tests this pass — fixes are server-side
guardrails on write paths that already had test coverage of the
happy path. End-to-end tenant-isolation tests are out of scope
for the pure-Node test harness; eval harness covers the
correctness path.

---

## v0.3.5 — 2026-05-10

Sixth-pass audit on Juno. Caught more critical-severity bugs than
the previous five passes combined — the kind that would have either
silently wiped data, broken queue display, polluted aggregations
with case-mismatched enum values, or let any unauthenticated caller
burn the Anthropic budget.

The user pushed back on the audit cadence: "the last 2 revisions
have shown big big problems." That's correct. Each pass with a
better method finds harder bugs. This pass deliberately hunted at
the project-killer severity.

### Fixed (data loss / wipe scenarios)

- **`loadKBFromServer` could wipe the entire KB on a transient
  server error.** The flow was: `api('/kb')` → if the response
  isn't a non-empty array, treat as "empty DB" and seed. **Any**
  non-array response — a 500, a 401, a malformed payload, a
  transient PostgREST hiccup — would trigger seeding. Seeding
  calls `saveKBSilent`, which posts the in-memory seed
  (`DEFAULT_KB`) → backend `DELETE-then-INSERT`s the tenant's KB
  with the seed. **Total KB loss from a single bad GET.** Now
  three explicit cases: non-empty array (load), empty array
  (seed), anything else (show local cache + error banner, do
  not touch the DB).

- **`/kb POST` with `entries: []` wipes the KB unconditionally.**
  The handler did `DELETE` first, then checked for empty entries
  and returned 200. If the frontend's `kb` global was somehow
  emptied (state corruption, repeated Delete clicks, malformed
  request), the DELETE ran and **no INSERT followed — the KB was
  gone with nothing to restore from**. Empty-entries refusal now
  lives at the top of the handler, before snapshot or DELETE.
  400 with an explicit message; if a clear-the-KB flow is ever
  needed it gets its own endpoint.

### Fixed (queue-display silent corruption)

- **`priorityTier` was broken for every saved row.** It required
  `parsed.clinical_routing_flag` (in addition to
  `clinical_routing_level !== 'none'`) to classify a row as
  severe-se / moderate-se / mild-se. But **`clinical_routing_flag`
  is not a column on `query_history`** — we never persist it. So
  every row loaded from the DB had `flag === undefined`, which
  silently demoted severe SE rows to plain "clinical" tier in the
  queue. **The "Severe Side Effects" filter on the Triage Queue
  page never matched anything.** The aggregate "Escalated" count
  still worked because it reads `clinical_routing_level`
  directly, bypassing priorityTier — but the queue UX was
  silently lying about its tier breakdown.

  Fix: derive `hasSE` from `clinical_routing_level !== 'none'`
  alone. The flag is redundant with the level (the AI's prompt
  requires them coherent) and `taskShape` had the same bug —
  both fixed. Tests added for the saved-row case.

### Fixed (data-quality)

- **No AI output normalization.** If the AI returned `'URGENT'`
  (uppercase), `'Side Effect'` (singular), `clinical_routing_level:
  'SEVERE'`, or `confidence: 1.5`, those values were saved raw.
  Effects:
  - "Top Category" aggregation split `'Side Effects'` and `'Side
    Effect'` into separate buckets, polluting the most-common-
    category metric.
  - The pill UI's strict-equality match on `c === aiClinCat`
    failed for case-mismatched categories — the AI's selected
    pill wasn't highlighted, staff couldn't tell what the AI had
    chosen.
  - `mean_ai_confidence` skewed by clamp violations.
  - Pre-filter / batch-eval logic that groups by `urgency` would
    treat `'URGENT'` and `'urgent'` as different.

  New helper `normalizeTriageOutput(parsed)` in `triage-lib.js`
  canonicalizes urgency / clinical_routing_level / clinical_category
  case-insensitively, defaults missing values to safe defaults,
  coerces booleans, ensures arrays, and clamps `confidence` to
  [0, 1]. Unknown clinical_category values are preserved (trimmed)
  rather than silently coerced — staff need to see what the AI
  actually returned. Called from `runTriage` before
  `saveHistoryRecord` and `renderResults`, and from `eval/run.js`
  before scoring so the eval matches what production persists.
  17 new tests.

### Fixed (security / cost-burn)

- **`/triage` had no auth check.** Anyone with the function URL
  could send any system prompt + max_tokens up to the cap and
  burn the Anthropic budget. The frontend wasn't even sending an
  Authorization header to it. Now requires a valid Supabase
  session JWT, identical to the guard added to `/analyze` in
  v0.3.4. Frontend updated to send the auth header. Eval harness
  updated with a `--token` flag (or `RELAI_EVAL_TOKEN` env var)
  for hitting the proxy via `--endpoint` against a deployed
  function.

### Fixed (silent data loss in ingest path)

- **`ingest.js` returned `201 Created` with `task_id: null` on
  insert failure.** The handler didn't check `r.ok` after the
  PostgREST POST; it just looked for `Array.isArray(result) &&
  result[0]`. If the insert failed (RLS, schema, connection),
  `result` was an error object, `taskId` was null, and the
  response was 201 anyway. **A webhook sender's caller would
  think the message was queued when it actually got dropped.**
  Silent data loss for every channel adapter we'll write in
  Phase 3. Now the response status reflects reality (4xx/5xx
  on insert failure) and includes a retry hint.

- **`ingest.js` didn't validate `company_id` on the matched API
  key.** The schema has `api_keys.company_id NOT NULL`, but a
  defensive check guards against schema drift. Without it, a
  null company_id would have inserted an orphan row that's
  invisible to all tenant-scoped queries.

### Audit method

The user pointed out that the previous five passes had each
found bigger bugs than the one before, suggesting the audit
method itself was incomplete. This pass tried to compensate by
explicitly hunting:

1. **Every "empty array" check that gates a destructive operation.**
   What happens if the response is non-array because of a 5xx?
   That's how the loadKBFromServer wipe surfaced.
2. **Every helper function read against a row from the DB.** Does
   the helper rely on fields the row doesn't have? That's how
   the priorityTier-without-flag bug surfaced.
3. **Every endpoint that calls Anthropic.** Auth + model gate +
   cap, all three. That's how the /triage missing-auth surfaced.
4. **Every trust boundary where AI output meets persistence.** Are
   we normalizing? Validating ranges? Coercing types? That's how
   the no-normalization bug surfaced.
5. **Every "success" response that doesn't actually verify success.**
   That's how the ingest.js silent-201 bug surfaced.

Codified as additional checklist items in AGENTS.md.

### Tests

109 passing across 8 files (was 91 across 7). 17 new tests
covering normalizeTriageOutput edge cases and priorityTier on
saved-row inputs without the unpersisted flag.

### Eval baseline at v0.3.5

| Metric | Value |
|---|---|
| `prompt_version` | `a615b5ad` (unchanged) |
| `kb_version` | `366cb3f1` (unchanged) |

Eval not re-run live this session because /triage now requires
auth and the harness needs a `--token` arg. Direct-Anthropic
mode (the default) works without a token. To validate against
the deployed proxy: grab a session JWT from the browser
localStorage (`relai_session.access_token`) and run
`npm run eval -- --endpoint <url> --token <jwt>`.

---

## v0.3.4 — 2026-05-10

**Critical data-integrity patch on Juno.** Fifth-pass audit caught
several issues that would have either silently broken the active
learning loop, or only surfaced as catastrophic data loss under
specific conditions. Migration 0007 required.

### ⚠️ DEPLOYMENT ORDER MATTERS

**Apply `migrations/0007_query_history_internal_note.sql` in Supabase
SQL Editor BEFORE the Netlify deploy completes.** This release
includes a frontend change that sends `internal_note` in the triage
insert payload. PostgREST will reject inserts referencing an unknown
column with a 400, which means **every triage save would fail until
the migration is applied**. The migration takes ~1 second; do it
first, then the deploy is safe.

### Fixed (data-integrity critical)

- **Read endpoints depended on RLS policies that don't exist in any
  migration.** `kb.js`'s `/kb GET`, `/history GET`, `/history/all
  GET`, `/reviews GET` all used `readHeaders(token)` (user JWT
  auth). Every tenant table has `enable row level security` set in
  baseline migrations but **zero `create policy` statements anywhere
  in the migration history**. The production system only worked
  because policies had been set ad-hoc in the Supabase dashboard —
  invisible to source control. A fresh deploy from migrations alone
  would have silently returned `[]` from every read endpoint:
  - The KB tab would show no entries → frontend fall-through would
    re-seed the KB on every page load.
  - The Triage Queue would show "No records yet" forever.
  - The Pending Review Items badge would always show 0.
  - The active learning loop's `promoteReviewToKB` would silently
    skip every staff answer (because the review-row lookup
    returned null → companyId null → kb_gap/protocol branch
    short-circuits).

  Fix: every read endpoint now uses the service key with an
  explicit `company_id=eq.<verified-user's-company>` filter, with a
  `user_id` fallback for users not yet attached to a company. The
  read path is now RLS-independent. Behavior no longer depends on
  Supabase-dashboard configuration drift. New helper
  `resolveCompanyId(user)` consolidates the lookup pattern that
  was duplicated across three different endpoints.

- **`/kb POST` could silently wipe the entire KB** if the snapshot
  read failed under RLS. The flow was: snapshot via user JWT →
  delete-all via service key → insert-new via service key. If
  insert failed, restore from the snapshot. With RLS denying the
  snapshot, `backup = []`, the delete still ran (service-key
  bypass), and any insert error meant total KB loss with nothing
  to restore from. Snapshot now uses service key so it sees what
  it's actually backing up.

- **`/kb POST`'s `DELETE` was untargeted across all tenants.** The
  query was `?id=neq.<all-zeros-uuid>` — i.e. delete every row
  whose id isn't all zeros, i.e. every row in the table, period.
  In single-tenant trial this is invisible. The moment a second
  tenant signs up, the first tenant pressing "Save & Sync" would
  wipe out every other tenant's KB. Now scoped to
  `company_id=eq.<theirs>`.

- **`saveReviewRequest` was fire-and-forget from `runTriage`.** If
  the call errored or the network blipped, the AI's flagged review
  request was silently lost — the triage row would exist but no
  `review_request` row linked to it. Staff would never see the
  AI's flagged uncertainty in Pending Review Items, the answer
  would never feed back into the KB via `promoteReviewToKB`, and
  the active learning loop would fail to close on those cases.
  Now awaited inside `runTriage` after `saveHistoryRecord`, with
  error handling that surfaces to the user.

- **AI's `internal_note` was never persisted.** Every other AI
  output field (`draft_response`, `follow_up_questions`,
  `non_clinical_items`, `clinical_category`, etc.) was saved on
  the triage row; `internal_note` was rendered in the UI and
  thrown away. That meant we couldn't audit "did staff act on the
  AI's routing recommendation?", couldn't analyze internal_note
  quality over time, couldn't eval against ground-truth
  comparisons, and couldn't feed it as a learning signal. New
  migration 0007 adds the column; saveHistoryRecord includes it
  in the payload.

- **`/analyze` endpoint had no auth, no model allowlist, no
  max_tokens cap.** Anyone with the function URL could burn
  Anthropic budget on Opus calls with 4096 max_tokens. The
  `/triage` proxy had been hardened against exactly this; `/analyze`
  was forgotten. Now mirrors `/triage`'s guards: auth required,
  haiku/sonnet only, 1024-token cap.

- **`update_urgency` accepted any string for `urgency_override`.**
  The TIMEFRAMES dropdown sends `routine | 24h | 24-72h | same-day
  | urgent`. The backend just patched whatever the client sent,
  with no validation. A misbehaving client could pollute the
  column with arbitrary strings, breaking aggregations that filter
  or group by urgency. Now the handler whitelists the five
  allowed values and rejects anything else with 400.

- **`kb.replace` audit-log entries were missing `company_id`.**
  Every audit row from a "Save & Sync" was written with
  `company_id=null`, making per-tenant audit queries miss them.
  Now passes `companyId` through.

### Added

- `migrations/0007_query_history_internal_note.sql` — adds the
  `internal_note text` column to `query_history`. Idempotent, safe
  to re-run.

### Audit method (this pass)

The user pointed out that the runTriage race condition (caught in
v0.3.3) was a project-killing class of bug — the kind that
silently corrupts learning data and makes you blame the AI for
problems the code created. This pass deliberately hunted at that
severity:

1. Trace every data-write end-to-end and ask "what happens when
   this fails silently?"
2. Look for places where AI output gets attached to the wrong
   record or where staff answers fail to reach where they need to
   go.
3. Audit the active learning loop specifically (review create →
   resolve → KB insert) for any link that could silently break.
4. Look for state inconsistencies where the same row would render
   differently in different views.
5. Check whether the data we're banking on for learning is
   actually being captured at all.

The RLS issue surfaced from check #1 (trace every write/read end-
to-end). The DELETE-all-tenants bug surfaced from #2 while
verifying tenant isolation. The internal_note loss surfaced from
#5 — auditing what data we're actually capturing.

### Tests

91 passing. No new tests — the affected paths are all PostgREST/
fetch-mediated and don't isolate cleanly in the pure-Node test
harness. End-to-end coverage now lives in the eval harness and
real-traffic behavior.

### Eval baseline at v0.3.4

| Metric | Value |
|---|---|
| Pass rate | 7/7 |
| `prompt_version` | `a615b5ad` (unchanged from v0.3.3) |
| `kb_version` | `366cb3f1` (unchanged) |
| Per-case cost (cold cache) | ~$0.013 |
| Mean latency | ~8.2s |
| Cache hit rate | ~85% (cold-then-warm pattern) |

### Going forward

This concludes the deep-audit cycle on Juno. Patch tags v0.3.1 →
v0.3.4 sit on top of v0.3.0. Bug count by pass: 8, 6, 9, 3, 8.
Total real bugs caught and fixed: **34**. The bug-finding rate
hasn't dropped to zero yet, but the remaining issues are likely
edge-case or speculative-design at this point. From here:

1. Apply migration 0007.
2. Use the app to generate real triage data.
3. Real-use bugs will be patched as they surface; further audits
   reach diminishing returns.

---

## v0.3.3 — 2026-05-10

Final patch on Juno before going hands-off through real-triage data
collection. Fourth-pass audit found two genuine bugs that the prior
three passes missed, plus one duplication smell that would have made
future drift between eval and production hard to spot.

This is the **last planned change** until Phase 3 work begins, unless
real production triages surface something major.

### Fixed (real bugs)

- **`prompt_version` was changing every day with no actual prompt
  change.** `BASE_PROMPT` includes a `Today: {{date}}` line whose value
  was interpolated at module load. The version-stamp hash was
  computed against the rendered prompt, so each day's date produced
  a different hash. This broke every downstream use of
  `prompt_version`:
  - The per-prompt-version breakdown in `/history/quality` would
    bucket by day rather than by actual prompt revision.
  - Eval baseline comparisons would always show a "different version"
    even when the prompt hadn't been touched.
  - The "did this regression follow a prompt change?" attribution
    question became unanswerable from production data alone.

  Fix: split `BASE_PROMPT_TEMPLATE` (structural, what we hash) from
  `BASE_PROMPT` (rendered, with today's date substituted in — what
  the AI sees). `getPromptVersion()` now hashes the template; the
  AI still sees the date. Eval and `app.js` both updated. Stable
  prompt_version going forward: `a615b5ad`. Existing rows in
  `query_history` keep their date-dependent stamps; no backfill —
  they're just legacy noise that aggregations can ignore.

- **Race condition in consecutive triages.** `runTriage` was
  fire-and-forget calling `saveHistoryRecord(...).then(id =>
  currentHistoryId = id)` — meaning two rapid triages could resolve
  out-of-order, leaving `currentHistoryId` pointing at the older
  triage. Every subsequent Save Categories / Save Timeframe / Submit
  & Learn would then patch the wrong row silently. Fixed by
  awaiting the save inside the try block before `setLoading(false)`
  releases the UI. Adds ~100-200ms of imperceptible wait after the
  ~8s the AI just took.

### Changed

- **KB section list extracted to `RELAI_DEFAULTS.kb_sections`.**
  `app.js`'s `getFullKB` and `eval/run.js`'s `buildKBString` had
  identical 6-row `[{key, label}, ...]` arrays inline. If they ever
  drifted, the eval's `kb_version` hash wouldn't match production —
  silent drift. Now both consume the shared constant. Tenants in
  Phase 4 will override per tenant.

### Audit method (this pass)

Fourth pass focused on the gaps in earlier passes:
- `login.html` end-to-end + race-condition reading of `app.js` async
  flows → caught the runTriage race.
- KB section list parity check between eval and app → caught the
  duplication.
- Eval re-run with side-by-side hash comparison vs prior baseline →
  caught the date-in-prompt-hash bug (prompt_version had drifted
  yesterday's `bb5ef312` → today's `23ac525a` without any prompt
  edit).

### Eval baseline at v0.3.3

| Metric | Value |
|---|---|
| Pass rate | 7/7 |
| `prompt_version` | `a615b5ad` (now stable across days) |
| `kb_version` | `366cb3f1` |
| Per-case cost (warm cache) | ~$0.009 |
| Mean latency | ~9.1s |
| Cache hit rate (warm) | ~99% |

### Tests

91 passing across 7 files. No new tests — affected paths
(prompt-version split, async race, KB section sharing) all rely on
fetch/DOM and aren't isolated enough to test in the current pure-Node
harness.

### Going forward

This concludes the audit cycle on Juno. Patch tags v0.3.1 / v0.3.2 /
v0.3.3 sit on top of v0.3.0. Next planned release is v0.4.0 when
Phase 3 (channel framework + queue + soft routing) lands. Between
now and then: real triage data collection. Bug reports surfaced by
real use will be patched; speculative audits won't add more.

---

## v0.3.2 — 2026-05-10

Patch on Juno (v0.3.0). Third-pass quality audit covering the
sections I'd skimped on previously — `login.html`, `auth.js`,
`styles.css`, `worker.js` semantics. None of these were causing
visible bugs in production, but each was either dead code, a
doubled-style typo with a confusing cascade, or a wrong-tenant
hardcode that would surface the moment a second tenant landed.

### Fixed / Removed

- **`login.html` was writing dead localStorage** under
  `relai_pending_profile` — never read by any consumer. The full
  name + department flow through the JWT's user_metadata via the
  OTP request body and `auth.js` reads them from there. The
  localStorage stash had been accumulating dead data in users'
  browsers since the original implementation. Removed.
- **Hardcoded "Big Easy Weight Loss" in the login footer.** Login
  is shared across tenants (we don't know which tenant a user
  belongs to until after auth). Footer is now generic
  "Protected by Relai." Tenant brand is shown post-login on
  the topbar via `currentProfile.company_name` as before.
- **`POST /auth/profile` handler in `auth.js` had no callers.**
  Defined to update `full_name` and `role`, but no UI surfaced an
  edit-profile flow. Removed (and the comment header). When an
  edit-profile UI lands, this handler can be re-added with the
  test it warrants.
- **`worker.js` lead comments were stale or misleading.** Updated
  the "EHR push-back" TODO to channel-pluggable framing matching
  the rest of the codebase, and replaced the misleading "lock
  window" comment (there was no actual lock — only a fast-PATCH
  race-narrowing) with an honest note about what's there and a
  pointer to the real claim mechanism for higher concurrency.

### CSS cleanups (no rendering change)

- **Duplicate `.severity-badge` declaration** at the top of the
  CLASSIFICATION section was being overridden by the later
  "Severity badge" section's version (different padding,
  border-radius, font-size). The earlier rule was rendering-dead.
  Removed.
- **Three bare `.sev-dot{background:...}` declarations** (red,
  amber, green) in succession — only the last applied per
  cascade, and even that was overridden by the later
  `.sev-dot{...background:currentColor...}`. The
  severity-specific dot color comes from descendant selectors
  (`.sev-severe .sev-dot`, etc.). The bare overrides were
  rendering-dead. Removed.
- **Duplicate `.history-stats` declaration** at line ~303 with
  `grid-template-columns:repeat(4,1fr)` was overridden by the
  later `repeat(auto-fit, minmax(170px, 1fr))` responsive
  variant. Earlier rule was dead. Removed.
- **Duplicate `.cat-save-btn.saved` declaration** in the
  "Restored missing classes" section duplicated the same rule
  defined alongside `.cat-save-btn` above. Removed the
  duplicate.
- **Three doubled-class selector typos** (`.learn-status.learn-status.error`,
  `.kb-sync-bar.kb-sync-bar.error`, `.btn-xs.btn-xs.save`) — the
  doubling was unintentional (no specificity competition that
  would have benefited from it). Collapsed to single class.

### Tests

91 passing, no new tests. Affected sections (login HTML, dead
auth handler, CSS) aren't testable in the pure-Node harness.

---

## v0.3.1 — 2026-05-10

Patch release on Juno (v0.3.0). Second-pass quality audit caught a
cluster of bugs that were causing the user-level statistics to look
wrong, plus a few mis-shaped data writes and a UI/library
classification mismatch. No new features. Patch versions on Juno
don't get separate codenames.

### Fixed

- **`getCompanyId()` always returned `null`.** It looked under
  `currentProfile.company_members`, but `auth.js` never populates
  that field (joins were dropped to avoid RLS-policy edge cases).
  Result: every triage row was being written with `company_id =
  NULL`, and the Cost/Quality endpoints' user-id fallback was the
  only thing keeping them returning anything sensible. Now reads
  `currentProfile.company_id` directly from the `profiles` row.
  Two duplicated dead `company_members` lookups in `initAuth` and
  `openProfile` cleaned up at the same time.
- **`saveCategoryTags` corrupted `clinical_category` with a
  concatenated string.** Earlier code joined clinical + non-clinical
  pill selections into one field
  (`"Side Effects | Non-clinical: Billing/Payment"`), polluting
  category-based aggregations like "Top Category." Now writes
  `clinical_category` (text), `non_clinical_items` (jsonb array),
  and `non_clinical_flag` (boolean) into their own columns.
  `kb.js`'s `update_category` handler updated to accept the split
  payload.
- **`renderResults` task-type label diverged from `priorityTier`
  / `taskShape`.** The inline logic treated any non-empty
  `clinical_category` (except a long-removed `'General/multiple'`
  value) as real clinical content, so messages categorized only as
  "General Inquiry" with non-clinical items rendered as "Dual Task"
  in the UI while everything else in the system classified them as
  non-clinical only. Now uses the shared library helpers; the UI
  label matches the queue's tier classification and the AI's
  intent.
- **"Correction Rate" conflated verbatim approvals with real
  edits.** Counted every row with a non-null `actual_response_sent`,
  but post-d8b6763 the verbatim-skip flow also writes
  `actual_response_sent` (with `edit_distance = 0`). Renamed to
  **Edit Rate** and computed from `edit_distance > 0`, with a
  fallback to `actual_response_sent` for legacy rows that don't
  have edit_distance populated. Help & Guide updated.
- **Per-staff breakdown column header read "Corrections" but the
  cell value was a percentage.** Renamed header to "Edit Rate"
  to match what's actually displayed.
- **Eight `} catch(e) {}` and toast-only catches across `app.js`
  and `login.html`** now log via `console.error('<context>:',
  e.message)` per AGENTS.md hard rule #2. The signOut catch is
  the only one that's deliberately fire-and-forget; it logs but
  doesn't surface to the UI.

### Removed

- Dead `kbCacheKey` variable (declared, never read).
- Dead `btn` lookup in `onTimeframeChange` (assigned, never used).
- Dead `'General/multiple'` category reference in `renderResults`
  (the value was retired from the prompt enum in v0.3.0; the check
  has been a no-op since).

### Changed

- `taskShape` lead comment in `triage-lib.js` reframed from
  "paste an internal note into the EHR" to channel-agnostic
  phrasing matching the rest of the codebase.

### Audit notes

The bugs in this patch were caught by re-reading `app.js`
semantically with adversarial intent — applying the new
"Auditing LLM call sites" + "watch for inlined UI state in LLM
content" checklist from AGENTS.md, plus tracing data flow from UI
state → fetch payload → DB column on every save action. None of
these were caught in the v0.3.0 quality pass because the audit
there was pattern-matching for known issue types (Bask refs,
silent catches, etc.) rather than reading flow.

### Tests

91 passing across 7 files. No new tests added — the affected
functions all depend on DOM/fetch and aren't testable in the
current pure-Node harness.

### Eval baseline at v0.3.1

Unchanged from v0.3.0 — none of these patches touched the prompt
or KB. Last recorded: `eval/results/2026-05-10T03-11-50-232Z.json`,
`prompt_version: bb5ef312`, `kb_version: 366cb3f1`, 7/7 cases pass.

---

## v0.3.0 "Juno" — 2026-05-10

**Waypoint release.** Closes out the foundation phase. Single-tenant
trial (Big Easy Weight Loss) is fully instrumented for the learning
work to come. Phase 3 (channel framework + queue + soft routing) is
designed and documented but not yet implemented.

Codename convention: significant releases get a short codename
alongside the SemVer number. "Juno" marks the first formally tagged
waypoint — the foundation everything else gets built on. Future
codenames continue alphabetically (next: "K…"). The codename is
informational; tooling and tags use the SemVer (`v0.3.0`).

### Added

- **Per-triage telemetry.** Every triage now writes `model`,
  `prompt_version`, `kb_version`, four token counts (input,
  output, cache_creation, cache_read), `latency_ms`,
  `ai_confidence`, and `cost_usd` onto its `query_history` row.
  Migration `0005_triage_observability.sql`. This is the foundation
  for measuring quality and cost trends, attributing regressions to a
  specific prompt or KB revision, and feeding the eval harness with
  real-world deltas.
- **Real eval harness.** `eval/run.js` runs every case in
  `eval/cases/*.json` against the current `BASE_PROMPT` + KB,
  scores against `urgency` / `clinical_routing_level` /
  `clinical_category` / `non_clinical_*` / `draft_must_include_any` /
  `draft_must_not_include` rules, writes a timestamped JSON to
  `eval/results/`, exits non-zero on regression. Direct Anthropic
  call by default (`ANTHROPIC_API_KEY` env var) or `--endpoint <url>`
  to route through a deployed proxy. Word-boundary matching for
  `must_not_include` so 2-letter tokens like "ER" don't trip
  "consider", "deliver", etc.
- **Eval cases.** Six starter cases at v0.3.0 baseline:
  `panc-001`, `anaphylaxis-001`, `mild-nausea-001`,
  `dual-task-001`, `plateau-001`, `food-noise-001`,
  `billing-only-001`. Curate from real `query_history`
  corrections going forward.
- **Per-tenant cost + quality endpoints.**
  `GET /history/cost?days=N` returns daily spend, model split,
  cache hit rate, mean latency. `GET /history/quality?days=N`
  returns urgency-override rate, correction rate, mean
  edit-distance, mean ai-confidence, with a per-prompt-version
  breakdown so a regression after a prompt change surfaces directly
  in the data. Both scoped to the caller's tenant.
- **Per-category `requires_clinical_authorization` flag** in
  `RELAI_DEFAULTS.categories`. Pure helper
  `requiresClinicalAuthorization(name, meta)` in `triage-lib.js`
  returns conservative defaults (true on unknown / empty input). The
  AI does NOT read this flag — it's a routing/queue concern.
  Foundation for replacing the binary `Clinical / Non-Clinical` role
  with capability flags in Phase 3.
- **Channel landscape and ownership model documented in PLAN.md
  Phase 3.** Bask is one of N pluggable channel adapters
  (`manual`, `api`, `bask`, `email`, `healthie`, `live_chat`, `sms`,
  `web_form`, `portal_direct`). Task ownership: one task, one
  primary owner via `claimed_by` lock; owner sends the one patient
  reply; cross-team work via structured `task_actions` (not
  free-text pastes); reassignment for misclassification feeds the
  learning loop.
- **Vertical-agnostic readiness audit in PLAN.md Phase 4.** Catalogues
  every Big-Easy-shaped piece (hardcoded categories, clinical-
  flavored prompt, `requires_clinical_authorization` naming,
  `clinical_*` columns, KB section keys, BAA assumption, eval cases)
  with what each needs to become for the next tenant — whether that
  tenant is medical or completely different vertical (auto, property,
  professional services).
- **Activity section** in the profile dropdown shows per-user
  triages today / last 7 days / all-time (via existing
  `/history/stats` endpoint, scoped to the calling user with
  service-key + JWT-verified user_id filter).
- **CHANGELOG.md** (this file).

### Changed

- **Renamed UI tab "Clinical Knowledge Base" → "Knowledge Base".**
  The KB always held non-clinical sections (routing, URLs); will
  hold more once non-clinical channels (email, web forms) feed into
  it.
- **Reframed the system as customer-service triage** at the
  architecture level (it always was; the framing was just biased
  toward clinical telehealth because Big Easy is the only tenant).
  README, AGENTS, PLAN, and adapter file lead-comments updated to
  reflect "channels are pluggable; verticals are configurable;
  Bask is one channel one tenant uses, not a load-bearing concept."
- **Single source of truth for category lists.** `CLINICAL_CATS`
  and `NON_CLINICAL_CATS` in `app.js` now derive from
  `RELAI_DEFAULTS.categories` instead of being hardcoded twice.
  Future tenant overrides will land in `tenants.category_metadata`.
- **Routing card UI** no longer says "paste into Bask chat." Now
  reads "share with the support team via your usual internal
  handoff (thread comment, internal email, ticket); you stay
  responsible for the patient reply." Channel-agnostic and
  ownership-aware.
- **Help & Guide** rewritten throughout to drop Bask references,
  document the actual entry path to the Triage Queue page (profile
  dropdown → Pending Review Items, not the hidden `•••` tab),
  describe what's actually on that page (AI clarifications +
  aggregate stats + record list), and clarify the routing-card
  ownership semantics.
- **`BASE_PROMPT` cleaned up.** Removed the contradictory category
  list from the JSON schema (the prompt was telling the AI two
  different category enums). Removed the deprecated
  `clinical_routing_note` field. De-duplicated the `review_request`
  description. Replaced "paste into Bask chat" with channel-
  agnostic phrasing. New `prompt_version: bb5ef312`.
- **`default-kb.js` CLINICAL ROUTING RULES entry** dropped the
  `clinical_routing_note format:` lines (the field was deprecated
  in the prompt but the KB was still describing how to format it).
  New `kb_version: 366cb3f1`.

### Fixed

- Activity section was returning aggregate counts under some RLS
  configurations instead of the per-user count. Switched to
  service-key reads with explicit JWT-verified `user_id` filter
  ([`9203e48`](#)).
- Triage telemetry writing `0` token counts as `NULL` due to
  `|| null` coercion. Switched to `?? null` so a real 0 is
  preserved as 0 ([`8bb6981`](#)).
- Eval scorer using case-insensitive substring match for
  `draft_must_not_include`, which made 2-letter tokens like "ER"
  trip on "consider", "deliver", etc. Switched to word-boundary
  regex ([`b664abf`](#)).
- Eval runner kept iterating cases after auth failures. Now fails
  fast on 401/403 with a pointer to where to get a fresh API key
  ([`6ae739b`](#)).
- Help text claimed staff could click a `•••` tab to reach the
  Triage Queue. That tab is hidden via CSS; the only entry point is
  profile dropdown → Pending Review Items. Help now describes the
  actual path.

### Removed

- Dead `getKBPrompt()` function in `app.js`. The KB-section-by-
  classifier approach was replaced by sending the full KB to take
  advantage of prompt caching; the function had no callers.
- Dead `since` variable in `worker.js`. Computed but never read.
- Dead `NON_CLINICAL_CATS` constant in `app.js`. Defined but never
  referenced; the actual category list lived inline and differed
  from the dead one. Both now derive from `RELAI_DEFAULTS.categories`.
- `clinical_routing_note` field in the AI's JSON schema (it was
  marked deprecated in the prompt and is not stored in `query_history`).
- `BASK_API_URL` / `BASK_API_KEY` framing in README env-var table
  reorganized into a "channel-specific env vars" subsection
  documenting that they'll move into `tenants.channels` jsonb in
  Phase 3.

### Code-quality

- Four `} catch(e) {}` silent-error swallows replaced with
  `console.error('<context>:', e.message)` per AGENTS.md hard rule
  #2: `saveReviewRequest`, `loadReviews`, `dismissReview` in
  `app.js` and the existing-session check in `login.html`.
- `data/triage-lib.js` exports `computeTriageCost`,
  `simpleHash`, `requiresClinicalAuthorization`,
  `TRIAGE_PRICING`. `data/defaults.js`, `data/base-prompt.js`,
  `data/default-kb.js` all gained Node-export hooks (no-op in
  browser) so tests and the eval harness can require them.

### Tests

- 91 passing across 7 files: `parseTriageJSON`,
  `classifyMessage`, `computeUrgencyScore`, `priorityTier`,
  `taskShape`, `formatDuration`, `levenshteinDistance`,
  `computeTriageCost`, `simpleHash`,
  `requiresClinicalAuthorization`,
  `aggregateCostRows`, `aggregateQualityRows`.

### Migrations

- `0005_triage_observability.sql` — adds 11 nullable observability
  columns to `query_history` plus indexes for time-series and
  version-attribution queries. Idempotent.

### Eval baseline at v0.3.0

| Metric | Value |
|---|---|
| Pass rate | 7/7 cases |
| `prompt_version` | `bb5ef312` |
| `kb_version` | `366cb3f1` |
| Cold-cache cost per case | ~$0.014 |
| Warm-cache cost per case | ~$0.009 |
| Mean latency | ~8.7s |
| Cache hit rate (warm) | ~99% of input tokens |
| Cost extrapolation @ 1,500 triages/day | ~$13/day, ~$400/month |

---

## Pre-history

Earlier development happened across many "Update kb.js" / unscoped
commits between 2026-04 and 2026-05-09. The repo's `0001`–`0004`
migrations capture the schema state going into v0.3.0. Going forward,
each release lands as one CHANGELOG entry plus a git tag.
