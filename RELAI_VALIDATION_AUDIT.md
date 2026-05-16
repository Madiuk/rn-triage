# Care Station — Validation Audit

A per-entry-point validation audit, following the surface inventory in
[RELAI_INPUT_SURFACES.md](RELAI_INPUT_SURFACES.md). For each entry: what the
code validates today, what library/pattern (if any) drives it, what slips
through, and the worst plausible consequence.

Two structural facts up front, because they apply to almost every entry:

1. **No validation library.** Nothing uses `zod`, `joi`, `ajv`, `class-validator`,
   or even a hand-rolled schema layer. Validation is ad-hoc: a few
   `if (!body.x) return 400`, two enum `Set`s, and `JSON.parse` in a `try/catch`.
2. **Rate limiting is partial.** `/ingest` is throttled at 60 req/min per API
   key (migration 0020). `/triage`, `/analyze`, `/auth/invite`, and Supabase
   Auth's magic-link OTP all remain open. The `/triage` exclusion is
   intentional per the clinical-sensitive deferral documented in PLAN.md § S2.
   Budget burn and brute-forcing on the unthrottled endpoints remain open
   vectors.

There is one positive baseline: the SPA escapes persisted text fields
(`patient_message`, `draft_response`, `correction_note`) through
[esc()](app.js:2619) before injecting them into `innerHTML`. So untrusted
strings reaching the staff UI via these fields are not XSS sinks today. Any
new render path that bypasses `esc()` would re-open the surface.

---

## 1. HTTP endpoints — Netlify Functions

### 1.1 `POST /.netlify/functions/ingest` — **HIGH risk**
- **Validation today:** Method check (POST). API-key auth via sha256 hash
  lookup against `api_keys`. `JSON.parse` in try/catch. Required field check:
  `message` must be present. `external_id` URI-encoded into PostgREST query.
- **Library/pattern:** none.
- **Slips through:**
  - `message` of any length — no upper bound. A 10 MB blob inserts straight
    into `query_history.patient_message`.
  - Arbitrary `channel` strings; not in any allowlist. A caller can set
    `channel='internal'`, `'admin'`, etc. — anything goes into
    `source_channel`.
  - `patient_id` is read out of the body but never persisted or validated.
  - No type check on `message` — `message: { toString: ... }`, `message: 123`,
    or `message: ["a","b"]` all serialize into the record (Supabase will reject
    non-string for a text column, but only at the DB layer).
  - No content-type check on the request.
  - No idempotency without an `external_id`: callers retrying without one
    create duplicate rows.
  - API-key brute force is throttled by a 60 req/min per-key limit
    (migration 0020), but the sha256 compare itself is still not timing-safe
    (`Array.isArray(keys) && keys[0]` short-circuits on miss). Brute-forcing
    is now bounded but not eliminated.
- **Worst consequence:** API-key brute-force eventually finds a valid key,
  giving an attacker the ability to flood a tenant's `query_history` with
  arbitrary content, which then:
  (a) drives Anthropic spend (when the worker is wired up),
  (b) pollutes aggregations (`/history/cost`, `/history/quality`),
  (c) feeds the active-learning loop via low-confidence review_requests, and
  (d) can be used to fill storage / DoS the queue. Even pre-brute-force, a
  legitimate-key holder can DoS by spamming long messages — there's no
  per-key throttle.

### 1.2 `POST /.netlify/functions/intercom` — **MEDIUM risk**
- **Validation today:** Method check. Env presence checks. **HMAC signature
  verification** with timing-safe compare (`crypto.timingSafeEqual`) against
  `INTERCOM_WEBHOOK_SECRET` — best validation in the codebase. `JSON.parse`
  in try/catch. Topic allowlist (`conversation.user.created`,
  `conversation.user.replied`); other topics ack with 200. `extractMessage`
  null-checks the payload shape. `stripHtml` is a regex-based HTML stripper.
- **Library/pattern:** `crypto.createHmac` + `crypto.timingSafeEqual` — solid.
- **Slips through:**
  - `stripHtml` is regex-based, not a real HTML parser. Crafted markup
    (`<scr<script>ipt>`, malformed nesting, comments containing `>`) can
    leave residue. Text is `esc()`-escaped before render, so this is not an
    immediate XSS sink, but the stored value is not what the patient typed.
  - No size cap on `messageHtml` — Intercom doesn't impose tight limits.
  - `INTERCOM_TENANT_COMPANY_ID` is a single env var; if it's misset, every
    Intercom message lands in the wrong tenant. No sanity check that the
    string is a UUID or that the company exists.
  - `authorName` is read from the payload and stored as `nurse_name`. An
    Intercom account whose display name is `"<patient>"` or `"admin"` will
    show up in the queue UI verbatim (escaped, so no XSS — but
    impersonation-by-display-name is possible).
- **Worst consequence:** Signature gate is strong, so the attack path here
  requires either secret leakage or an Intercom account in the wired tenant.
  Given those, the attacker can inject arbitrary `patient_message` content
  routed into the tenant's queue, plus impersonate display names. Similar
  downstream effects to §1.1 once the worker is wired.

### 1.3 `POST /.netlify/functions/bask` — **LOW risk (today), HIGH if wired**
- **Validation today:** Method check. Env presence check. `JSON.parse`. Required
  fields `triage_id` and `response_text`. Handler currently returns 501.
- **Library/pattern:** none.
- **Slips through:** Everything — there's no auth at all. `triage_id` is not
  validated as a UUID nor checked to exist in `query_history`. `response_text`
  has no length cap. `thread_external_id` is opaque.
- **Worst consequence (today):** none — 501. **Worst once wired:** any
  caller posts arbitrary text to any Bask thread under the tenant's API key,
  framing the practice as having said anything. Outbound impersonation. This
  endpoint MUST gain auth and same-origin enforcement before BASK_API_KEY is
  plumbed in.

### 1.4 `/.netlify/functions/worker` — **MEDIUM risk** (scheduled, currently disabled)
- **Validation today:** Env presence checks. Nothing else.
- **Library/pattern:** none.
- **Slips through:** No HTTP auth. Anyone with the URL can trigger a drain
  cycle. Currently a stub, so the drain just flips `status='pending' →
  'triaged'` and writes an `audit_log` row — limited damage today.
- **Worst consequence:** Once real triage is wired in, repeated triggers
  drive Anthropic spend. Also confuses observability if the scheduler is
  expected to be the sole driver of `audit_log` events of type
  `triage.skip_stub` / future `triage.run`.

### 1.5 `GET /.netlify/functions/auth/profile` — **LOW risk**
- **Validation today:** JWT bearer check against `${SUPABASE_URL}/auth/v1/user`.
  Substring-match dispatch by path. Method check (`GET`). User-id presence in
  the auth response.
- **Library/pattern:** JWT verification via Supabase Auth round-trip (not
  local-verify with JWKS). One extra hop per call but correctness is
  delegated to Supabase.
- **Slips through:**
  - `user_metadata.full_name` and `user_metadata.department` are stamped into
    the new `profiles` row on first call with no length cap, no charset check,
    and no department allowlist. Whatever the user typed at signup becomes
    `profiles.full_name` and `profiles.role` directly.
  - The `default-company auto-attach` logic relies on `companies?select=id&limit=2`
    — if the DB happens to be in a transitional state with exactly one row, a
    new user silently joins that tenant. There's no consent step; the user
    can't know which tenant they were attached to.
- **Worst consequence:** Garbage `full_name`/`role` propagating into the
  audit log and the staff queue UI. Tenant misattachment when companies
  table is transiently 1-row.

### 1.6 `POST /.netlify/functions/auth/invite` — **HIGH risk**
- **Validation today:** Env presence check (`SUPABASE_SERVICE_KEY`).
  `JSON.parse`. Required: `email`. `role` defaulted to `"staff"`. **No
  caller auth check, no role check, no rate limit.**
- **Library/pattern:** none.
- **Slips through:**
  - Email format is not validated. Supabase will reject most malformed
    addresses, but the surface is fully open to whatever the caller sends.
  - `role` is not in any allowlist — any string lands on `profiles.role`.
  - `company_id` is caller-supplied and not validated as a UUID, not checked
    to exist, and not checked to be the caller's tenant (because there is
    no caller).
  - With `email_confirm: true`, the created user is immediately confirmed
    and can sign in.
- **Worst consequence:** **Tenant takeover / data exfiltration.** An
  unauthenticated attacker creates a confirmed auth user attached to any
  `company_id` they pick, with any `role`. Once they log in, they read that
  tenant's full KB, history, and reviews via the standard `/kb/*` endpoints —
  the tenant scope is derived from `profiles.company_id`, which the attacker
  controlled at creation time. This is the highest-severity finding in the
  audit and is exposure-1.

### 1.7 `POST /.netlify/functions/auth/signout` — **LOW risk**
- **Validation today:** Token is optional; if present, JWT verified before the
  `last_seen` PATCH.
- **Library/pattern:** JWT verification via Supabase Auth round-trip.
- **Slips through:** No body validation, but the handler doesn't read one.
- **Worst consequence:** Best-effort timestamp PATCH with no other side
  effects. Negligible.

### 1.8 `POST /.netlify/functions/triage` — **HIGH risk** (cost + prompt-injection)
- **Validation today:** JWT bearer check. `JSON.parse`. `model` allowlist
  (`claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`). `max_tokens`
  clamped to `[1, 4096]`. Body forwarded verbatim to Anthropic.
- **Library/pattern:** none.
- **Slips through:**
  - `system` and `messages` arrays are **never validated** — any
    authenticated caller can set arbitrary system prompts, can prepend
    cache-control breakpoints however they want, and can change the assistant
    persona. The server doesn't enforce the BASE_PROMPT + KB shape the
    frontend assembles; it just proxies.
  - `messages` content can be arbitrarily large — only `max_tokens` (the
    output) is capped. Input-token spend per call is bounded only by
    Anthropic's hard limits.
  - Per-user / per-tenant call-volume cap: none. One compromised JWT can burn
    the entire `ANTHROPIC_API_KEY` budget at Opus rate × parallel calls.
  - The response is forwarded raw; nothing limits response size or rejects
    malformed JSON beyond the 502 catch.
  - Prompt injection from `patient_message` content (the actual hostile-input
    surface a clinical product cares about) is not addressed — the model
    output then lands in `draft_response` and may include instructions to the
    next reader. (UI escapes it for HTML, but staff read it and act on it.)
- **Worst consequence:** A signed-in user (or anyone who gets a token via the
  weak §1.6 path) can:
  (a) drain the Anthropic budget with Opus-tier calls,
  (b) replace the system prompt to make Claude emit anything they want under
      the practice's brand,
  (c) emit JSON shaped to manipulate `clinical_routing_level` /
      `clinical_category` on `query_history`, since the frontend trusts the
      model's structured output for those fields.

### 1.9 `POST /.netlify/functions/kb/analyze` — **MEDIUM risk** (cost)
- **Validation today:** JWT bearer check. `JSON.parse`. `model` allowlist
  (Haiku + Sonnet). `max_tokens` clamped to `[1, 1024]`.
- **Library/pattern:** none.
- **Slips through:** Same as `/triage` for `system`/`messages` — arbitrary
  shape. No call-volume cap.
- **Worst consequence:** Anthropic budget burn (cheaper than `/triage`
  because Opus is excluded and the cap is 1024). Same persona-replacement
  vector but the output is much smaller.

### 1.10 `GET|POST /.netlify/functions/kb` (KB CRUD) — **MEDIUM risk**
- **Validation today:** JWT bearer check. Tenant scope resolved server-side.
  Per-entry `company_id` overwritten to the caller's. Empty-entries refusal
  (400) to block accidental DELETE-only saves. Snapshot → DELETE → INSERT
  with rollback on insert failure.
- **Library/pattern:** none.
- **Slips through:**
  - `entries[i].section` is unconstrained — only specific sections feed the
    prompt-builder, but any string can be stored.
  - `name`, `content`, `position` are not bounds-checked. A
    `content: "..." (5 MB)` entry will be POSTed straight to PostgREST.
  - `entries[]` size is unconstrained at the handler level. Posting 100k
    entries in one call is allowed.
  - The KB content directly drives the cached system prompt for every triage
    in the tenant — an authenticated user can effectively rewrite the
    clinical reasoning the AI applies.
- **Worst consequence:** Any authenticated user in the tenant (including any
  user planted via §1.6) can replace the entire clinical KB. Subsequent
  triages then route patients according to attacker-chosen rules. Detection
  is via audit log (`kb.replace` with `prior_count` and `count`), but the
  damage is immediate.

### 1.11 `GET /.netlify/functions/kb/history*` — **LOW risk**
- **Validation today:** JWT bearer check. `days` parsed as int, clamped 1–90.
  Tenant scope by `company_id` (or per-user fallback).
- **Library/pattern:** none.
- **Slips through:** `days` is the only input; the clamp covers it. Other
  endpoints take no body.
- **Worst consequence:** Negligible.

### 1.12 `POST /.netlify/functions/kb/history` — **MEDIUM risk**
- **Validation today:** JWT bearer check. Role gates on clinical-tier rows via
  `permissions.js` predicates (non-clinical can't mutate clinical rows). Per-
  row tenant scoping via `&company_id=eq.<callers>` and a 404 if PostgREST
  returns `[]`. `urgency_override` validated against `URGENCY_OVERRIDE_VALUES`.
  `update_category` gates `clinical_category` to clinical staff. `id` is the
  only ID required.
- **Library/pattern:** Role checks centralized in
  [permissions.js](netlify/functions/_lib/permissions.js).
- **Slips through:**
  - Free-text fields (`actual_response`, `correction_note`, `downvote_reason`,
    `upvote_reason`, `non_clinical_items[]`) — no length caps, no shape
    checks. A 5 MB `correction_note` writes straight to PostgREST.
  - `non_clinical_items` is taken as-is if `Array.isArray` — element types
    are not checked.
  - `session_duration_seconds` and `edit_distance` accept any non-null value —
    no `Number.isFinite` guard, no upper bound. NaN / Infinity will throw at
    Postgres but not before.
  - On the default (insert) branch, the spread `Object.assign({}, body, ...)`
    accepts every field the client sends — `cost_usd`, `urgency_original`,
    `kb_version`, etc. The schema (NOT NULL constraints) is the only filter.
- **Worst consequence:** A signed-in user can write arbitrary structured-but-
  unvalidated rows that distort cost/quality dashboards and the corrections
  learning feed. Cross-tenant writes are blocked by the JWT-forced
  `company_id`.

### 1.13 `GET|POST /.netlify/functions/kb/reviews` — **MEDIUM risk**
- **Validation today:** JWT bearer check. Tenant scope on lookup +
  PATCH-WHERE. Role gate on `resolve` (clinical-only when origin triage is
  clinical). Double-resolve refused (409). `applied_to` is one of
  `kb` / `kb_failed` / `confirmation`.
- **Library/pattern:** Role checks in
  [permissions.js](netlify/functions/_lib/permissions.js).
- **Slips through:**
  - `answer`, `question`, `patient_message`, `ai_draft`, `resolved_by_name` —
    no length caps. `slice(0,80)` is applied to the question for the KB
    entry name, but the full `answer` and `question` are stored in the
    promoted `kb_entries.content`. A 100 KB "answer" lands in the KB.
  - `context` is taken verbatim from the body; only `kb_gap` and `protocol`
    drive promotion, but any string is stored.
  - `confidence` is not range-checked; the AI emits `[0, 1]` but the handler
    will accept `999` or `-1`.
- **Worst consequence:** A signed-in tenant user can rewrite the KB through
  the review-resolve path with a fake review (create + resolve). Same end-
  state as §1.10 (KB rewrite), just via a different code path. The active-
  learning loop is a privileged channel — its trust hinges on the staff who
  resolve reviews actually reading what they're approving.

### 1.14 `GET /.netlify/functions/kb/profile` — **LOW risk**
- **Validation today:** JWT bearer + method check. No body.
- **Worst consequence:** Negligible.

### 1.15 `GET /.netlify/functions/kb/handoff-template` — **LOW risk**
- **Validation today:** JWT bearer + method check. `company_id` required.
- **Worst consequence:** Negligible.

### 1.16 `GET /.netlify/functions/kb/categories` — **LOW risk**
- **Validation today:** JWT bearer + method check. `company_id` required.
- **Worst consequence:** Negligible.

### 1.17 `GET|POST /.netlify/functions/kb/admin/users` — **MEDIUM risk**
- **Validation today:** JWT bearer + `is_admin` check. `is_super_user`
  promotions require the caller to already be super-user. `role` validated
  against `{'Clinical','Non-Clinical'}`. `is_admin`/`is_super_user` typeof
  boolean. Self-demotion of super-user refused. PATCH tenant-scoped by
  `company_id`.
- **Library/pattern:** none.
- **Slips through:**
  - `user_id` is not validated as a UUID; PostgREST will reject malformed
    inputs at the DB layer.
  - No bulk-update guard — admin posts trigger one user at a time. Acceptable.
- **Worst consequence:** A tenant admin can flip arbitrary roles for users
  in their own tenant. By design — but combined with §1.6, an attacker who
  plants a profile with `is_admin:true` (via `auth/invite`'s ungated role
  argument) can reach this endpoint and elevate other planted users.

### 1.18 `GET|POST /.netlify/functions/kb/admin/categories` — **LOW risk**
- **Validation today:** JWT bearer + `is_super_user`. Typed fields validated
  (`is_clinical`, `is_active`, `display_order`). PATCH tenant-scoped.
- **Slips through:** `category_name` has no length cap. `display_order` is
  not range-checked.
- **Worst consequence:** Super-user can mislabel categories; impact is the
  picker-visibility rules in the UI for the same tenant only.

### 1.19 `GET|POST /.netlify/functions/kb/admin/settings` — **LOW risk**
- **Validation today:** JWT bearer + `is_super_user`. `template` required,
  must be non-empty string, capped at 4000 chars. **Only handler in the
  codebase with an explicit length cap on a free-text field.**
- **Slips through:** `template` content is otherwise free-form.
- **Worst consequence:** Super-user can change tenant handoff text; tenant-
  scoped.

---

## 2. Scheduled / background jobs

### 2.1 `worker` (scheduled)
See §1.4 — same handler.

---

## 3. Direct browser → Supabase Auth calls

### 3.1 `POST ${SUPA_URL}/auth/v1/otp` — **MEDIUM risk**
- **Validation today (client-side):** [login.html](login.html) checks
  presence of `email`, `name`, `dept`. No format check on email, no length
  cap on `name`, no allowlist on `dept` beyond what the `<select>` offers
  (which the user can bypass by editing the request).
- **Library/pattern:** none — raw XHR to Supabase Auth.
- **Slips through:** Supabase Auth itself validates email format and rate-
  limits OTP per-email. But `user_metadata.full_name` and
  `user_metadata.department` are arbitrary attacker-controlled at submit time.
  They land in the JWT and then on `profiles` on first auth/profile call.
- **Worst consequence:** A user signs up with `department: 'Clinical'` they
  shouldn't have, getting non-admin clinical permissions on first profile
  creation. Department is the seed for `profiles.role`, which gates
  clinical mutations (§1.12). Real impact: privilege seeding from the signup
  form.

### 3.2 `POST ${SUPA_URL}/auth/v1/token?grant_type=refresh_token` — **LOW risk**
- **Validation today:** Supabase verifies the refresh token. Client passes
  through whatever's in localStorage.
- **Slips through:** No client-side validation — Supabase is the gate.
- **Worst consequence:** Negligible at the app layer.

---

## 4. Untrusted LLM output (Claude API responses)

### 4.1 Claude triage response (Sonnet) — **HIGH risk**
- **Validation today (server, [triage.js](netlify/functions/triage.js)):**
  HTTP status check (non-2xx passes through verbatim). `JSON.parse` of the
  response body in try/catch, 502 on failure. Adds a server-built `_relai`
  envelope. **No validation of `content`, `usage`, or any structured field.**
- **Validation today (client, [app.js](app.js) + [data/triage-lib.js](data/triage-lib.js)):**
  `parseTriageJSON` extracts JSON from the model's free-form text.
  `normalizeTriageOutput` lowercases enum values (`URGENT` → `urgent`).
  `clinical_routing_level` accepted from the model with no allowlist check
  beyond what `buildSeverityBadge` knows how to render (falls back to no
  badge for unknown values). `review_request.confidence` is read with a
  `typeof === 'number'` check.
- **Library/pattern:** none. `parseTriageJSON` is hand-rolled in
  [data/triage-lib.js](data/triage-lib.js).
- **Slips through:**
  - The model can return any clinical category, any urgency, any draft text.
    Out-of-allowlist values for `clinical_category` and
    `clinical_routing_level` are persisted unchecked. Aggregations split into
    new buckets.
  - `follow_up_questions[]` and `non_clinical_items[]` are stored as the
    model returned them — no length cap, no element-type check.
  - `confidence` outside `[0, 1]` would pass any numeric check; the
    review-threshold logic (`< 0.75`) silently shifts behavior if the model
    drifts to a different scale.
  - **Prompt injection** in the patient message can make the model emit
    JSON shaped to:
    (a) downgrade urgency for a clinically dangerous message,
    (b) emit a high `confidence` to suppress the review-queue entry,
    (c) embed instructions in `draft_response` aimed at the staff reader.
    The UI HTML-escapes the draft, so script execution isn't on the table,
    but the staff member is the second-stage executor — they read the draft
    and may copy it into Bask / Intercom verbatim.
- **Worst consequence:** A crafted patient message bypasses the AI safety
  guardrails (low confidence → review queue, severe routing → clinical
  escalation), reaches a non-clinical staff member with a soothing draft, and
  is sent to a patient who needed urgent care. This is the dominant
  patient-safety risk in the system today.

### 4.2 Claude analyzer response (Haiku) — **LOW–MEDIUM risk**
- **Validation today:** None on the server beyond status pass-through. Client
  concatenates `content[].text` and stores the result on
  `query_history.correction_note`.
- **Slips through:** Any text the model returns. Persisted unsanitized; UI
  uses `textContent` ([app.js:1739](app.js:1739)) or `esc()`
  ([app.js:1901](app.js:1901)) when rendering.
- **Worst consequence:** Misleading "learning note" attached to a triage row
  influences future staff calibration and quality dashboards. Not a clinical
  decision pathway, so the patient-safety implication is small. Misuse of
  the proxy is mostly a budget concern (§1.9).

### 4.3 Future: Bask / Intercom outbound responses — **deferred**
- Not wired today; will require validation when implemented.

---

## 5. Ranked risk table

| Rank | # | Entry | Severity driver |
|---|---|---|---|
| **HIGH** | 1.6 | `POST /auth/invite` | Unauthenticated creation of confirmed users with caller-chosen tenant + role → full tenant compromise. |
| **HIGH** | 4.1 | Claude triage response | Patient-safety pathway; prompt injection in patient messages can produce misleading drafts and urgency. |
| **HIGH** | 1.1 | `POST /ingest` | Public webhook; 60 req/min/key limit (migration 0020) caps queue-spam blast radius, but sha256 compare is not timing-safe and a valid-key holder can still flood within the limit. |
| **HIGH** | 1.8 | `POST /triage` | Unbounded system/messages; arbitrary persona + Opus-tier budget burn per signed-in user (or planted user). |
| **HIGH (future)** | 1.3 | `POST /bask` | No auth — once wired, lets any caller post outbound text under the practice's brand. |
| MEDIUM | 1.2 | `POST /intercom` | HMAC gate is strong; downstream effects same as §1.1 if the secret leaks. Regex HTML-strip is fragile. |
| MEDIUM | 1.4 | `worker` | No HTTP auth; benign today, becomes a budget burn vector when wired. |
| MEDIUM | 1.9 | `POST /kb/analyze` | Same `/triage` shape but bounded model + 1024-token cap. |
| MEDIUM | 1.10 | `GET\|POST /kb` | Authenticated tenant user can replace the entire clinical KB; only audit_log surfaces it. |
| MEDIUM | 1.12 | `POST /kb/history` | Role gates are good; free-text fields have no caps; numeric fields are unchecked. |
| MEDIUM | 1.13 | `GET\|POST /kb/reviews` | Self-create + self-resolve is a backdoor into the KB; relies on staff sanity-checking what they approve. |
| MEDIUM | 1.17 | `/kb/admin/users` | Privilege juggling is correctly gated; compounds with §1.6 if that's exploited. |
| MEDIUM | 3.1 | `${SUPA_URL}/auth/v1/otp` | `user_metadata.department` is attacker-controlled and seeds `profiles.role`. |
| LOW | 4.2 | Claude analyzer response | Misleading learning notes; not on the patient-safety path. |
| LOW | 1.5 | `GET /auth/profile` | Single-tenant auto-attach edge case; `user_metadata` propagates unchecked. |
| LOW | 1.7 | `POST /auth/signout` | Best-effort timestamp. |
| LOW | 1.11 | `GET /kb/history*` | Clamps the one numeric input. |
| LOW | 1.14–1.16 | `/kb/profile`, `/kb/handoff-template`, `/kb/categories` | Read-only, tenant-scoped. |
| LOW | 1.18 | `/kb/admin/categories` | Super-user only, tenant-scoped. |
| LOW | 1.19 | `/kb/admin/settings` | Super-user only; **only** entry with an explicit length cap. |
| LOW | 3.2 | `${SUPA_URL}/auth/v1/token` (refresh) | Supabase-side validation. |

---

## 6. Cross-cutting gaps

Patterns that recur across most entries and would each take one small piece of
infrastructure to fix:

- **No schema validator.** Introducing `zod` (or equivalent) at the edge of
  every Netlify handler would replace ~20 hand-rolled checks with declarative
  schemas, would catch every "free-text field with no length cap" listed
  above, and would type the inputs at the same time. The fixes are local —
  one schema per route module.
- **Rate limiting is partial.** `/ingest` shipped (migration 0020, 60 req/min
  per API key, fail-open). `/triage`, `/analyze`, and `/auth/invite` remain
  open. The Postgres-backed counter + RPC pattern in 0020 generalizes — same
  shape would extend to the other endpoints when their triggers fire.
- **No input-size caps.** Only `/admin/settings.template` has one (4000
  chars). Everything else accepts arbitrarily large strings until PostgREST
  / Postgres rejects them — which is a 4xx far down the stack instead of an
  early bounce.
- **Caller-supplied IDs are not type-checked as UUIDs.** Most are URI-encoded
  into PostgREST filters, which is safe, but malformed IDs surface as 400/500
  from PostgREST instead of a clean handler-level 400.
- **LLM outputs are trusted as structured data.** The triage proxy forwards
  Claude's response, and the frontend trusts `clinical_routing_level`,
  `clinical_category`, `urgency_original`, and `confidence` as written. A
  small server-side validator on `/triage`'s response (allowlist enums,
  range-clamp confidence) would close the safety-critical part of §4.1
  without changing the model contract.
