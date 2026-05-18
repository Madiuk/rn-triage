# ROADMAP.md — Execution roadmap toward task management v1

Time-boxed execution plan for the next ~4 weeks of build.

[PLAN.md](PLAN.md) is the strategy / principles document — read that
for *why* and *what shape*. ROADMAP.md is the *when* and *which file
next*.

Last updated: 2026-05-16.

---

## Context

**Target.** Big Easy staff using a new pull-based task management
surface in production ~4 weeks from now. "Production" here means
staff working real tasks against the new queue, producing real
correction signal — **not** "production-ready in the public-launch
sense." Auto-send stays off; every patient reply still goes through
human-in-the-loop review. The point of v1 is to start gathering
data and iterating, not to be feature-complete.

**Parallel build, single cutover.** Everything new lives in new
files. The current system (`index.html` + `app.js` + Triage tab +
every existing endpoint) is untouched until Week 4. The cutover is
a single deploy that renames `index.html` → `manual.html` and
`tasking.html` → `index.html`. The manual paste flow is preserved
permanently as the manual ingestion surface — for tenants without an
adapter, or for one-off messages staff need to triage outside their
channel. Rollback is `git revert`.

**First screen after login = the staff's pending queue.** Existing
`login.html` already redirects to `/` post-auth; the file rename
at cutover picks up the new SPA automatically.

**Parallel safety guardrails:**
- Only additive migrations (new nullable columns, defaulted
  booleans). No drops, no renames, no NOT NULL adds on existing
  data.
- New endpoints only (`/queue/pull`, `/queue/retask`,
  `/queue/reassign`, `/queue/mine`, `/queue/send`). The triage
  path stays unchanged in v1 per CLAUDE.md principle 4.
- New channel adapters go into `netlify/functions/channels/`.
  Existing `intercom.js` stays at its current path so the live
  webhook URL doesn't change. Moving it is a separate maintenance
  task, post-cutover.
- `worker.js` gains real triage + the SLA-sweep job, but no
  scheduler is added in `netlify.toml` until Week 4. Until then
  the file changes have zero production blast radius (nothing
  invokes worker in production today).
- A behavior-preserving helper extraction of the triage path is
  permitted under CLAUDE.md principle 4 with explicit description
  and confirmation; see "Status" below for what landed.

---

## Status — 2026-05-18

**Cutover complete.** The `tasking.html` → `index.html` rename described in
Week 4 shipped. File layout below; references to `tasking.html` in the
week-by-week prose are now historical.

| Path | File | Notes |
|---|---|---|
| `/` (default) | `index.html` + [tasking.js](tasking.js) + [tasking-styles.css](tasking-styles.css) | The Phase 3 tasking SPA — staff home page. |
| `/manual.html` | [manual.html](manual.html) + [app.js](app.js) + [styles.css](styles.css) | Legacy paste-and-triage SPA. Super-user-only via profile-panel gate. |
| `/login.html` | [login.html](login.html) | Email + password sign-in. Magic-link sign-in retired Phase 4. |
| `/reset-password.html`, `/accept-invite.html` | dedicated pages | Recovery + invite landings. |

**Worker scheduler live** ([netlify.toml:49-58](netlify.toml:49), `0 */4 * * *` cron on `worker-background`). The in-SPA "Fetch & triage" button was retired 2026-05-17; the second invocation path is now operator-triggered direct HTTP to the function URL.

**Auth model changed.** From magic-link (Phase 4 retirement) → email + password. Recovery via `/auth/v1/recover` (lands at `/reset-password.html`); invites via `/accept-invite.html` (admin-only via `/auth/invite`). See [ARCHITECTURE.md](ARCHITECTURE.md) for the current picture.

**Recent polish (queue UX, 2026-05-17/18):**
- Loading state on queue refresh (no false-empty flash before tasks land)
- Pull dropdown now 2 columns, 580px wide (Pull confirm always in viewport)
- Manual Refresh button removed (auto-refresh handler open as a future discussion)
- Init fetches parallelized (categories + queue concurrent after profile)
- Intercom outage replay scripts shipped (`replay-intercom.js`, multiple fixes)

**Open items for the cleanup pass before new adapters land:**
- Three HIGH-rank findings still in [PLAN.md "Security backlog"](PLAN.md) — rate limiting on `/triage` and `/analyze`, `/triage` body validation, AI output semantic trust.
- `maybeBootstrapFirstAdmin` (auto-super-user on first sign-in) must be replaced before tenant #2 lands.
- `OUTBOUND_LIVE_MODE` kill-switch defaults to off (sandbox mode); flipping to live is a deliberate action when the first tenant goes outbound.

---

## Status — 2026-05-16 (evening)

**Week 1 substrate is functionally complete.** What's landed and
shipped to production:

| Item | Status | Commit |
|---|---|---|
| Migration 0022 — queue state columns + `task_reassignments` | ✓ applied | (prior to this session) |
| Migration 0023 — `fin_participated` flag on `query_history` (defense in depth against Intercom's AI Agent) | ✓ applied | `9214ca6` |
| Phase 3 queue: defaults, permissions, route handlers, `/queue/*` rewrite | ✓ landed | `c9f1828` |
| Intercom inbound: Fin participation detection, `fin_participated` flag set on insert | ✓ landed | `9214ca6` |
| Triage core extraction (`_lib/triage-core.js`); `triage.js` reduced to HTTP wrapper | ✓ landed, behavior-preserving | `289f288` |
| Worker: real triage via `triage-core`, Fin defense routing, retry-on-failure | ✓ landed | `173896e` |
| SLA sweep: 24h-from-pull + 8h-from-reply Due-state flip (separate function) | ✓ landed | `a0dbf17` |
| Queue endpoint tests + handler refactor for testability (9 pure helpers extracted; 85 new tests) | ✓ landed | `8b02e64` |

**Test suite: 697 / 697 passing** as of this commit.

**Production smoke test passed end-to-end** (Intercom Developer Hub
endpoint verification, 2026-05-16 ~8:30 PM). Webhook reachable,
signature verification operational, env vars wired:
`INTERCOM_WEBHOOK_SECRET`, `INTERCOM_TENANT_COMPANY_ID`.

### Items not in the original Week 1 plan but landed

- **Migration 0023 + Fin defense.** Added after the Intercom doc deep-dive
  surfaced the `ai_agent_participated` flag in webhook payloads.
  Care Station now persists this flag on every inbound row; the worker
  routes flagged rows to `status='reviewed'` without calling Claude.
  Defensive — Fin is dormant in Big Easy's workspace today (no
  workflows, no charges).
- **Triage core extraction.** Extracted `runTriage()` orchestration into
  `_lib/triage-core.js` so the worker can invoke the same code path the
  HTTP endpoint uses without a JWT round-trip. Refactor is
  behavior-preserving; full test suite stayed green (554 before, 612
  after Week 1's new tests).
- **`INTERCOM_SETUP.md`** — runbook for connecting an Intercom workspace
  to Care Station. Captures the operational steps walked through
  tonight (separate Intercom app per integration, env-var setup, smoke
  test procedure, common-issue triage). Useful for onboarding the next
  tenant.

### Still outstanding in Week 1

- **First real-message smoke test through the worker.** Webhook
  reachability verified; full path (Intercom message → DB row → worker
  triage → triaged status with classification fields) not yet exercised
  with a live test message. Operational check, not code.

### Known gaps surfaced during build (not Week 1 blockers)

- Nothing currently writes `last_patient_reply_at`. The 8h SLA sweep is
  built and tested but inert until the patient-reply wiring lands
  (likely Week 3 when the chart view stitches threads together).
- Worker invocation is manual until Week 4 (`netlify.toml` scheduler
  block stays commented out).
- Outbound API token (separate from the inbound webhook secret) is not
  yet needed and not yet provisioned; that's Week 3 outbound work.

---

## Week 1 — Substrate (DB + worker + endpoints)

**Goal:** the bones of the pull queue exist server-side and pass
tests, before any UI consumes them.

### 1.1 Migration 0022 — Queue state columns
File: `migrations/0022_query_history_queue_state.sql` (new)

Adds to `query_history`:
- `first_pulled_at timestamptz` (nullable) — anchor for 24h SLA
- `last_patient_reply_at timestamptz` (nullable) — anchor for 8h SLA
- `due_state boolean default false` — sticky after first SLA expiry

`claimed_by uuid` and `claimed_at timestamptz` columns are added
here too if not already present in production. (Source declares
them in the queue work; verify against actual schema before
applying.)

Adds new table `task_reassignments` (audit trail for category
reassignment events) — small table, FK to `query_history.id`.

All additive. No drops, no NOT NULL adds, no renames.

**Per CLAUDE.md principle 4: requires explicit chat confirmation
before the SQL file is written.**

### 1.2 New endpoints
File: `netlify/functions/queue.js` (new). Tests in `tests/`.

| Endpoint | Body | Behavior |
|---|---|---|
| `POST /queue/pull` | `{ categories: string[] }` | Returns up to 5 tasks, claim-locks them. Server-side: capability gating, idle-unlock rule, sticky-Due queue lock, 5-cap. Severity > Due > normal priority order. |
| `POST /queue/retask` | `{ triage_id }` | Releases `claimed_by` to NULL; preserves `due_state`. Server-side ownership check. |
| `POST /queue/reassign` | `{ triage_id, new_category }` | Reassigns category, releases ownership, writes `task_reassignments` row. |
| `GET /queue/mine` | — | Returns the caller's current pending queue (up to 5 rows). |
| `POST /queue/send` | `{ triage_id, final_text }` | Dispatches reply via channel adapter (`intercom.js` outbound for v1; `healthie.js` outbound when ready). Status: `triaged` → `reviewed` → `sent`. Closes task. |

Tenant scoping via server-verified JWT (caller's tenant), never
from request body — per CLAUDE.md non-negotiables.

Test files: `queuePull.test.js`, `queueRetask.test.js`,
`queueReassign.test.js`, `queueMine.test.js`, `queueSend.test.js`.

### 1.3 Worker.js — real triage + SLA sweep
File: `netlify/functions/worker.js` (modify)

Two concerns added to the existing drain loop:

**Real triage call.** For `status='pending'` rows: call the
Anthropic proxy (`/triage`) and persist the result. Replaces the
current stub placeholder. The triage path *itself* is not modified
— this is the worker calling it for the first time.

**SLA sweep.** Scan rows where:
- `first_pulled_at < now() - interval '24 hours'` AND status not
  in (`closed`, `sent`), OR
- `last_patient_reply_at < now() - interval '8 hours'` AND status
  not in (`closed`, `sent`).

For each match: release `claimed_by`, set `due_state = true`, write
an `audit_log` entry tagged with which window expired and the prior
`claimed_by` value (for the learning loop).

No scheduler added yet — `netlify.toml` change lands in Week 4.

Test file: `workerSlaSweep.test.js`.

### 1.4 Definition of done — Week 1
- [x] Migration 0022 written, reviewed, applied (after explicit
  chat confirmation)
- [x] Migration 0023 — `fin_participated` flag (added beyond original
  plan, defense in depth against Intercom's AI Agent)
- [x] Five new endpoints exist; bad input returns 4xx; success
  paths write `audit_log` entries
- [ ] All Week-1 test files added and passing — **partial**: worker
  + SLA-sweep + Fin-defense helpers covered (61 new tests);
  queue endpoint tests still outstanding
- [x] `worker.js` real-triage path works on manual invocation
  (verified against staging via `curl`)
- [x] SLA sweep flips `due_state=true` on test fixtures (in
  `sla-sweep.js`, separate function from the worker)
- [x] Triage core extracted to `_lib/triage-core.js` — behavior-
  preserving refactor performed with explicit confirmation per
  CLAUDE.md principle 4
- [x] No semantic changes to `/triage` contract; HTTP behavior
  identical pre/post-refactor (test suite confirms)
- [x] No changes to `/ingest`, `/auth/*`, `/kb/*`, `/admin/*`,
  current `app.js`, or current `index.html`

---

## Week 2 — New SPA shell (tasking surface)

**Goal:** new web page where staff log in, see their pending queue,
pull tasks via the dropdown. Page enforces 5-cap, capability
gating, Due-lock client-side too (server stays source of truth).

### 2.1 Scaffold
New files at repo root:
- `tasking.html` — queue-first SPA entry. Mirrors the demo's topbar
  pattern but uses real auth (not the demo role-switcher).
- `tasking.js` — shell + queue rendering + pull dropdown + task
  list state.
- `tasking-styles.css` — port relevant rules from
  `demo-styles.css`. Theme parity with current `styles.css`.

### 2.2 Auth + first-screen paint
- `tasking.html` uses the optimistic-paint pattern from current
  `index.html` (the inline script that reads
  `relai_profile_cache` to populate the chip before scripts load).
- On load: `GET /queue/mine` populates the staff's pending queue.
  Empty state shows the pull dropdown prominently.

### 2.3 Pull dropdown
- Multi-select checkbox dropdown of categories.
- Pre-checked from `profile.category_preferences`.
- Capability gating: non-eligible categories greyed out unless
  idle-unlock applies (server confirms; UI mirrors).
- Submit calls `POST /queue/pull`; on success, the returned tasks
  populate the queue.
- Disabled when queue has any items (strict-batch refill).
- Disabled with inline reason when queue contains 5 Due tasks
  (sticky-Due queue lock).

### 2.4 Queue list rendering
Task row shows:
- Priority chip (severe / due / normal)
- Category + channel badge
- Urgency score / age
- Due flag (if set)
- One-line summary of the patient message
- Click row → opens task chart (Week 3)

### 2.5 Definition of done — Week 2
- [ ] `tasking.html` loads, shows queue, pull dropdown works
- [ ] Staff in a clean DB state can pull 5 tasks; refill is
  disabled until at least one closes
- [ ] Capability gating + idle-unlock + Due-lock all visible in UI
- [ ] No changes to `index.html` / `app.js`
- [ ] At least one test file for pure helpers (priority sort,
  capability filter, Due-lock logic)

---

## Week 3 — Task chart view

**Goal:** clicking a task opens a full-window detail view with the
patient's chat thread, stored context, and quick-links. URLs only
for v1; no live external API pulls.

### 3.1 Chart layout
New section in `tasking.js` + `tasking.html`:
- **Left rail:** patient identity (name from channel, external_id,
  channel badge), age, key flags (clinical / non-clinical,
  urgency, Due if set).
- **Center column:** chat thread + AI draft. Thread sourced from
  `query_history` rows that share the same patient anchor (best
  available: `external_id` chain, falling back to
  `(company_id, patient_name)` if no anchor exists for that
  channel — finalize per channel).
- **Right rail:** quick-links panel. Reads from a new
  `tenants.quick_links jsonb` column (added in migration 0022 or
  a small follow-up migration — TBD when we write the SQL).
  Each link: `{ label, url_template, channel? }`. Template
  placeholders: `{patient_id}`, `{external_id}`,
  `{channel_thread_id}`. Renders as clickable buttons.

### 3.2 Quick-link config (defaults, no admin UI)
File: `data/defaults.js` (modify — add `quick_links` to
`RELAI_DEFAULTS`).

Hardcoded for Big Easy: Bask patient profile URL template,
payment processor URL template, Intercom conversation URL
template. Per-ingestion admin UI is deferred (see *Defer list*).

### 3.3 Reply flow
- Staff edits draft, clicks "Send."
- `POST /queue/send` (from Week 1) dispatches via channel adapter.
- v1 outbound: Intercom only. Healthie outbound depends on
  Healthie's API readiness — may land Week 4, may slip to v1.1.
- Status transitions: `triaged` → `reviewed` → `sent`.
- Task closes; staff queue drops by one; refill remains locked
  until queue hits 0.

### 3.4 Re-task button
Next to Send. Calls `/queue/retask`. Task returns to pool. If
Due, the flag persists.

### 3.5 Definition of done — Week 3
- [ ] Click on a task row opens the chart view
- [ ] Chart shows chat thread, AI draft, quick-links from defaults
- [ ] Staff can edit + Send via Intercom outbound; status persists
- [ ] Re-task works; sticky Due preserved
- [ ] Test for quick-link template substitution (pure function)
- [ ] No changes to `index.html` / `app.js`

---

## Week 4 — Healthie adapter + Intercom outbound + cutover

**Goal:** Healthie inbound feeds the queue with real tasks; file
rename swaps the new SPA to the `/` route; manual paste tool
reachable at `/manual.html`.

### 4.1 Healthie inbound adapter
File: `netlify/functions/channels/healthie.js` (new). Test file:
`tests/healthieInbound.test.js`.

- Webhook handler. URL path depends on Netlify subdirectory
  behavior — verify before committing the URL on Healthie's side.
- HMAC verification using `HEALTHIE_WEBHOOK_SECRET` env var.
- Normalizes Healthie's payload to a `query_history` insert with
  `source_channel='healthie'` and
  `external_id='healthie:<conv_id>:<msg_id>'`.
- Idempotent by `external_id` (matches existing pattern in
  `intercom.js`).

**This depends on the Healthie webhook contract.** Block: obtain
Healthie's payload schema and webhook secret format before Week 4
starts. If they slip, Healthie inbound moves to v1.1 — v1 ships
Intercom-only.

### 4.2 Intercom outbound
File: `netlify/functions/intercom.js` (modify)

Add `sendOutbound(triage_id, text)` that posts the reply back via
Intercom's Conversations API. Wire it into the `/queue/send` flow
(from Week 1).

Intercom file stays at current path to preserve the live webhook
URL.

### 4.3 Cutover
1. Rename: `index.html` → `manual.html`, `tasking.html` → `index.html`.
2. Verify `login.html`'s post-auth redirect still works (redirects
   to `/`, which now picks up the new SPA).
3. Add scheduler in `netlify.toml`:
   ```
   [[scheduler]]
   path = "/.netlify/functions/worker"
   schedule = "*/5 * * * *"
   ```
4. Deploy.

Rollback: `git revert` the rename commit + remove the scheduler.

### 4.4 Staff dry-run
- 2–4 hours, 2 staff members, real Intercom traffic (plus Healthie
  if landed).
- Brad supervises. Issues logged, not blocking unless patient-
  safety-impacting.
- Sign-off criterion: queue mechanics work, chart renders,
  replies send, SLA sweep flips Due correctly.

### 4.5 Definition of done — Week 4
- [ ] Healthie inbound webhook handler exists, tests pass,
  deployable (activation depends on Healthie-side config)
- [ ] Intercom outbound works end-to-end on a test conversation
- [ ] File rename complete; new SPA at `/`, manual paste at
  `/manual.html`
- [ ] Worker scheduler active in `netlify.toml`
- [ ] Staff dry-run completed, sign-off documented in CHANGELOG.md

---

## What we defer (and the re-engagement trigger)

| Item | Re-engagement trigger |
|---|---|
| Phase 2 active learning loop (weekly per-tenant style summary, automated KB-update suggestions) | First month of post-cutover correction data; trigger on >100 corrections/week per tenant |
| Multi-tenant vertical-agnostic prep (renames, per-tenant categories, neutral prompt) | Tenant #2 in sales conversation |
| Bask adapter (inbound + outbound) | Bask publishes their webhook contract OR Big Easy switches to Bask as primary |
| Per-ingestion admin UI for quick-link config | Adding 2nd or 3rd channel makes the hardcoded `defaults.js` painful, OR a tenant requests custom links |
| Phase 5 advanced learning (embeddings, fine-tuning) | >10k corrections accumulated per tenant |
| Auto-send (no human review) | Measured AI correction rate <5% AND staff workload pressure justifies it AND audit item S3 resolved |
| Preferences view UI (category preferences editing) | v1.1, ~1 week after cutover |
| Training view UI (AI quality stats) | Phase 2, after active learning loop |
| Welcome modal | Stretch — when there's a free day |
| Moving `intercom.js` into `channels/` directory | Maintenance window scheduled outside business hours |
| Resend integration for transactional emails (invites, password resets, future notifications) — own templates, replace Supabase built-in SMTP | Resend account ready (2026-05-17). Trigger: when the "Reset password" subject line on a fresh invite starts confusing real invitees, OR when deliverability matters for production sign-ups. Resend templates also unblock own-domain sender (`hello@carestation.app`) instead of Supabase's `noreply@mail.app.supabase.io`. |

---

## Risks + mitigation

**R1. Healthie contract delays.** If Healthie's webhook contract or
secret isn't ready by Week 4 start, Healthie inbound slips to v1.1.
v1 still ships Intercom-only — staff get the queue + chart running
on Intercom traffic. Healthie is additive, not gating.

**R2. 4-week scope is tight.** Two mitigations: (a) Preferences UI
already deferred — easy to defer Training UI too. (b) Chart view
degrades gracefully — if quick-link config takes longer, ship
URLs-only with just the Big Easy hardcodes; admin UI is already
deferred.

**R3. Dual-write complexity during build.** None. Parallel files
means no dual-write. The current system and new system both read
from the same `query_history` table, but only the new system writes
the new columns (`first_pulled_at`, `last_patient_reply_at`,
`due_state`). The current system ignores them.

**R4. SLA-sweep mis-fires after cutover.** Worker isn't scheduled
until Week 4. Post-cutover mitigation: first 24h, run worker
manually rather than scheduled. Watch `audit_log` for unexpected
`due_state=true` flips. If anything looks wrong, remove the
scheduler from `netlify.toml` (one-line revert) — current system
continues to work.

**R5. Schema drift.** Per the 2026-05-10 decision log there's known
drift on `review_requests.created_by`. Run `list_extensions` and
check `query_history` actual columns against the migration before
applying. Standard pre-migration hygiene.

**R6. Patient-safety regression.** The triage path (prompt, parse,
confidence gate, KB retrieval) is **not** modified in v1. The new
queue mechanics surround the triage path, not inside it. Per
CLAUDE.md principle 4, any change to the triage path itself
requires explicit description and confirmation; v1 has none.

---

## Acceptance criteria for go-live

Before Week-4 cutover, all must be true:

- [ ] All Week-1 through Week-3 tests pass
- [ ] All existing tests still pass (no regressions in current
  system)
- [ ] Migration 0022 applied to production; pre/post column check
  confirms additive change only
- [ ] Manual paste tool reachable at `/manual.html` and functional
  on a test triage
- [ ] One end-to-end staff flow exercised: pull → chart → send →
  Intercom outbound → patient receives reply
- [ ] SLA sweep tested on fixtures: 24h initial expiry and 8h
  reply expiry both flip `due_state=true` and release `claimed_by`
- [ ] Worker scheduler entry committed but commented out; activated
  only after the dry-run confirms no anomalies
- [ ] CHANGELOG.md entry written for the cutover

---

## Cross-references

- [PLAN.md](PLAN.md) — strategy, principles, decisions log, the
  full ownership model + capability framework
- [CLAUDE.md](CLAUDE.md) — working agreement, non-negotiables
- [INPUT_SURFACES.md](INPUT_SURFACES.md) — current
  endpoint inventory; new `/queue/*` endpoints to be added here as
  they ship
- [CHANGELOG.md](CHANGELOG.md) — running log; cutover gets its own
  entry
