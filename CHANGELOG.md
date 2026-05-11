# CHANGELOG

Notable changes to Relai. The format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/) (relaxed pre-1.0 — minor
bumps cover meaningful capability additions, patch bumps cover fixes).

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
