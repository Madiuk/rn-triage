# CHANGELOG

Notable changes to Relai. The format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/) (relaxed pre-1.0 — minor
bumps cover meaningful capability additions, patch bumps cover fixes).

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
