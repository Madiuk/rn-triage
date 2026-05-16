# Care Station — Input Surfaces

Every place untrusted data enters the system. Compiled from a read-only audit of
`netlify/functions/`, `app.js`, `login.html`, and `eval/run.js`. No code was
changed.

"Entry" here covers anything Care Station treats as input it didn't author itself:
HTTP request bodies, webhook payloads, scheduled-job triggers, third-party
integrations, **and** LLM (Claude API) responses — since model output is also
untrusted text that flows into the DB, the UI, and downstream prompts.

Tenant scoping in this codebase is enforced in code (the routes filter by
`company_id` via the Supabase service key); RLS is enabled on most tables but
declares no SELECT policies, so the application layer is the only enforcement.

---

## 1. HTTP endpoints — Netlify Functions

### 1.1 `POST /.netlify/functions/ingest`
- **File / handler:** [netlify/functions/ingest.js](netlify/functions/ingest.js) — `exports.handler`
- **Type:** Generic inbound webhook (channel-agnostic).
- **Who can call it:** Any external caller holding a valid Care Station API key. The
  key is matched against `api_keys.key_hash` (sha256 of the bearer secret) sent
  in either `X-Relai-Api-Key` or `Authorization: Bearer <key>`. Tenant is
  derived from `api_keys.company_id`.
- **Accepts (JSON body):**
  - `message` (required) — patient/user message text, stored verbatim in
    `query_history.patient_message`.
  - `channel` (optional, default `"api"`) — channel id (`bask`, `healthie`,
    `email`, `sms`, `live_chat`, `web_form`, ...).
  - `patient_id` (optional) — currently ignored by the insert.
  - `external_id` (optional) — used for `(company_id, external_id)` idempotency.
- **Side effects:** inserts a `query_history` row with `status='pending'`;
  fire-and-forget `last_used` PATCH on the API key.

### 1.2 `POST /.netlify/functions/intercom`
- **File / handler:** [netlify/functions/intercom.js](netlify/functions/intercom.js) — `exports.handler`
- **Type:** Intercom webhook (third-party integration).
- **Who can call it:** Public URL. Execution gated by HMAC signature
  verification against `INTERCOM_WEBHOOK_SECRET` (`X-Hub-Signature-256` or
  `X-Hub-Signature`, timing-safe compare). Tenant is hardcoded for the
  single-tenant trial via `INTERCOM_TENANT_COMPANY_ID`.
- **Accepts (JSON body — Intercom's payload shape):**
  - `topic` — only `conversation.user.created` and `conversation.user.replied`
    are acted on; other topics get a 200 with `ignored:true`.
  - `data.item.id` — conversation id.
  - `data.item.source.body` / `data.item.conversation_parts[]` — message HTML
    (passed through [`stripHtml`](netlify/functions/intercom.js:138)).
  - Author info (`author.email`, `author.name`).
- **Side effects:** inserts a `query_history` row with
  `source_channel='intercom'`, `external_id=intercom:<convId>:<partId>`,
  `status='pending'`.

### 1.3 `POST /.netlify/functions/bask`
- **File / handler:** [netlify/functions/bask.js](netlify/functions/bask.js) — `exports.handler`
- **Type:** Outbound channel stub (Bask Health EHR). Currently returns 501.
- **Who can call it:** Anyone with the URL — **no auth check today** (only an
  env-var presence check for `BASK_API_URL` / `BASK_API_KEY`). Intended to be
  same-origin / server-side only once wired.
- **Accepts:** `{ triage_id, response_text, thread_external_id? }`.
- **Side effects:** none (stub).

### 1.4 `/.netlify/functions/worker`
- **File / handler:** [netlify/functions/worker.js](netlify/functions/worker.js) — `exports.handler`
- **Type:** Scheduled background job. Currently **disabled** in
  [netlify.toml](netlify.toml) (the `[[scheduled.functions]]` block is
  commented out); when re-enabled it runs `* * * * *`.
- **Who can call it:** The Netlify scheduler — but the handler has **no HTTP
  auth check**, so anyone with the URL can also trigger a batch drain
  (`SUPABASE_URL` + service key are the only requirements). Treat as
  internal-only until/unless an auth check is added.
- **Accepts:** no request body. The handler queries Supabase for up to
  `WORKER_BATCH_SIZE` (5) pending `query_history` rows.
- **Side effects:** flips `query_history.status` to `triaged` (currently a stub
  that doesn't yet call Anthropic); writes an `audit_log` row.

### 1.5 `GET /.netlify/functions/auth/profile`
- **File / handler:** [netlify/functions/auth.js](netlify/functions/auth.js) — `exports.handler`
- **Type:** Authenticated read.
- **Who can call it:** Any authenticated user (Supabase JWT in
  `Authorization: Bearer`). Lazy-creates a `profiles` row from `user_metadata`
  on first call.
- **Accepts:** no body. Reads `user_metadata.full_name` and
  `user_metadata.department` from the JWT-resolved user — both came from
  values the user typed into the login form (see §3.1).

### 1.6 `POST /.netlify/functions/auth/invite`
- **File / handler:** [netlify/functions/auth.js](netlify/functions/auth.js) — `exports.handler`
- **Type:** Authenticated write (Supabase Auth admin create).
- **Who can call it:** **Anyone who can reach the function URL.** The handler
  gates only on `SUPABASE_SERVICE_KEY` being present on the server — there is
  no caller-role check, no JWT requirement, and no admin gate. This is the
  weakest auth surface in the function set.
- **Accepts (JSON body):** `email` (required), `company_id`, `role` (default
  `"staff"`).
- **Side effects:** creates a Supabase Auth user via
  `POST /auth/v1/admin/users` with `email_confirm:true`, PATCHes the matching
  `profiles` row, and inserts a `company_members` row if `company_id` given.

### 1.7 `POST /.netlify/functions/auth/signout`
- **File / handler:** [netlify/functions/auth.js](netlify/functions/auth.js) — `exports.handler`
- **Type:** Authenticated best-effort PATCH.
- **Who can call it:** Anyone; token optional. If a valid token is supplied,
  bumps `profiles.last_seen` for that user.
- **Accepts:** no body.

### 1.8 `POST /.netlify/functions/triage`
- **File / handler:** [netlify/functions/triage.js](netlify/functions/triage.js) — `exports.handler`
- **Type:** Anthropic API proxy (clinical triage, Sonnet).
- **Who can call it:** Authenticated users only (Supabase JWT validated against
  `/auth/v1/user`).
- **Accepts (JSON body):** Anthropic Messages request shape —
  - `model` (must be in `claude-sonnet-4-6` / `claude-haiku-4-5` /
    `claude-opus-4-7` allowlist),
  - `max_tokens` (capped server-side at 4096),
  - `system` blocks (cache-controlled),
  - `messages[]` — `content` carries the patient message + prior conversation
    serialization built client-side in [app.js](app.js:993).
- **Side effects:** forwards verbatim to `https://api.anthropic.com/v1/messages`
  using the server-side `ANTHROPIC_API_KEY`; decorates the upstream JSON with a
  `_relai` envelope (latency, cost, usage).
- **Return value is an entry point too** — see §4.1.

### 1.9 `POST /.netlify/functions/kb/analyze`
- **File / handler:** [netlify/functions/_lib/routes/analyze.js](netlify/functions/_lib/routes/analyze.js) — `handle`
- **Type:** Anthropic API proxy (correction analyzer, Haiku/Sonnet only).
- **Who can call it:** Authenticated users only.
- **Accepts:** Anthropic Messages request body. `model` allowlist is
  `claude-haiku-4-5` / `claude-sonnet-4-6`; `max_tokens` capped at 1024.
- **Return value is an entry point** — see §4.2.

### 1.10 `GET|POST /.netlify/functions/kb` (knowledge-base CRUD)
- **File / handler:** [netlify/functions/_lib/routes/kb-crud.js](netlify/functions/_lib/routes/kb-crud.js) — `handle`
- **Type:** Tenant-scoped CRUD.
- **Who can call it:** Any authenticated user in the tenant. (Writes used to
  silently wipe KBs under RLS — see the file's safety comments.)
- **Accepts:**
  - `GET` — no body. Returns every `kb_entries` row for the caller's
    `company_id`.
  - `POST` — `{ entries: [{ section, name, content, position, ... }] }`.
    Per-entry `company_id` is overwritten server-side to the caller's. Empty
    `entries` array refused (400) to prevent DELETE-then-INSERT wiping the
    tenant KB.
- **Side effects:** snapshot → DELETE → INSERT, with rollback on insert
  failure; `audit_log` write on success.

### 1.11 `GET /.netlify/functions/kb/history*`
- **File / handler:** [netlify/functions/_lib/routes/history.js](netlify/functions/_lib/routes/history.js) — `handle`
- **Type:** Authenticated reads, tenant-scoped.
- **Who can call it:** Any authenticated user. Per-user vs tenant scope
  depends on whether the caller has a resolved `company_id`.
- **Endpoints + inputs:**
  - `/history/stats` — no inputs; returns counts.
  - `/history/cost?days=N` — `days` query param, parsed as int, clamped 1–90.
  - `/history/quality?days=N` — same shape as `/history/cost`.
  - `/history` — corrections feed (rows with `actual_response_sent` or
    `correction_note`).
  - `/history/all` — up to 200 rows for the tenant.

### 1.12 `POST /.netlify/functions/kb/history`
- **File / handler:** [netlify/functions/_lib/routes/history.js](netlify/functions/_lib/routes/history.js) — `handle`
- **Type:** Authenticated dispatcher with role gates.
- **Who can call it:** Authenticated users. Role gates via
  [permissions.js](netlify/functions/_lib/permissions.js):
  non-clinical can't mutate clinical-tier rows.
- **Accepts (JSON body):** `action` switch over —
  - `update_urgency` — `urgency_override` validated against `URGENCY_OVERRIDE_VALUES`.
  - `update_category` — `category` (clinical-only), `non_clinical_items[]`,
    `non_clinical_flag`.
  - `upvote` / `downvote` — `reason` free text.
  - `save_actual` — `actual_response`, `correction_note`, `session_duration_seconds`,
    `edit_distance`.
  - `delete_correction` — id only.
  - `mark_escalated` — `actual_response` optional.
  - `delete_entry` — id; cascades to `review_requests`.
  - default — full row insert; `user_id` and `company_id` forced from JWT.

### 1.13 `GET|POST /.netlify/functions/kb/reviews`
- **File / handler:** [netlify/functions/_lib/routes/reviews.js](netlify/functions/_lib/routes/reviews.js) — `handle`
- **Type:** Authenticated reads + writes; role-gated resolve.
- **Who can call it:**
  - `create` — any authenticated user (emits whenever AI flags low confidence).
  - `resolve` — same tenant + must be clinical when origin triage is clinical.
  - `dismiss` — same tenant.
- **Accepts (JSON body):**
  - `create` — `triage_id`, `question`, `context`, `confidence`,
    `patient_message`, `ai_draft`. `company_id` + `created_by` forced from JWT.
  - `resolve` — `id`, `answer`, `resolved_by_name`, `context` (drives KB
    promotion); `kb_gap`/`protocol` contexts insert into `kb_entries`.
  - `dismiss` — `id`.

### 1.14 `GET /.netlify/functions/kb/profile`
- **File / handler:** [netlify/functions/_lib/routes/profile.js](netlify/functions/_lib/routes/profile.js) — `handleProfile`
- **Type:** Authenticated read of caller's own row.
- **Who can call it:** Any authenticated user.
- **Accepts:** no body.

### 1.15 `GET /.netlify/functions/kb/handoff-template`
- **File / handler:** [netlify/functions/_lib/routes/profile.js](netlify/functions/_lib/routes/profile.js) — `handleHandoffTemplate`
- **Type:** Authenticated tenant-scoped read.
- **Who can call it:** Any authenticated user with a `company_id`.
- **Accepts:** no body.

### 1.16 `GET /.netlify/functions/kb/categories`
- **File / handler:** [netlify/functions/_lib/routes/profile.js](netlify/functions/_lib/routes/profile.js) — `handleCategories`
- **Type:** Authenticated tenant-scoped read of `category_metadata`.
- **Who can call it:** Any authenticated user with a `company_id`.
- **Accepts:** no body.

### 1.17 `GET|POST /.netlify/functions/kb/admin/users`
- **File / handler:** [netlify/functions/_lib/routes/admin.js](netlify/functions/_lib/routes/admin.js) — `handleUsers`
- **Type:** Tenant-scoped admin endpoint.
- **Who can call it:** `is_admin = true` profile required. Setting
  `is_super_user` further requires the caller to already be a super-user.
- **Accepts:**
  - `GET` — no body; lists tenant users + emails from `auth.users`.
  - `POST` — `{ action:"update_role", user_id, role?, is_admin?, is_super_user? }`.
    `role` validated to `'Clinical'|'Non-Clinical'`. Self-revoke of
    `is_super_user` refused.

### 1.18 `GET|POST /.netlify/functions/kb/admin/categories`
- **File / handler:** [netlify/functions/_lib/routes/admin.js](netlify/functions/_lib/routes/admin.js) — `handleCategories`
- **Type:** Super-user only, tenant-scoped.
- **Who can call it:** `is_super_user = true` profile.
- **Accepts (POST):** `action: "update" | "create"`, with `id`, `is_clinical`,
  `is_active`, `display_order`, `category_name`.

### 1.19 `GET|POST /.netlify/functions/kb/admin/settings`
- **File / handler:** [netlify/functions/_lib/routes/admin.js](netlify/functions/_lib/routes/admin.js) — `handleSettings`
- **Type:** Super-user only, tenant-scoped.
- **Who can call it:** `is_super_user = true` profile.
- **Accepts (POST):** `action: "update_handoff_template"`, `template` string
  (non-empty, capped 4000 chars).

---

## 2. Scheduled / background jobs

### 2.1 `worker` (Netlify scheduled function)
- **File:** [netlify/functions/worker.js](netlify/functions/worker.js)
- **Schedule:** `* * * * *` in [netlify.toml](netlify.toml) — currently
  commented out, will be the only scheduled handler when re-enabled.
- **Input:** dequeues up to 5 `query_history` rows where `status='pending'`.
- **Trust boundary:** the rows themselves came from §1.1 / §1.2 / future
  channel adapters — i.e. external input arriving via Supabase Postgres, not
  via the worker's own HTTP envelope.

---

## 3. Direct browser → Supabase Auth calls

The SPA also talks directly to Supabase (not through Netlify functions) for
session-only operations. These are entry points for the **Supabase project**,
not for the Netlify proxy, but they accept user-typed data that flows into the
JWT and then into §1.5's profile-creation path.

### 3.1 `POST ${SUPA_URL}/auth/v1/otp`
- **File / call site:** [login.html:276](login.html:276)
- **Type:** Magic-link request to Supabase Auth.
- **Who can call it:** Public (anon key).
- **Accepts:**
  - `email` — user-typed.
  - `data.full_name` — user-typed at login.
  - `data.department` — user-selected (drives initial `role`).
  - These values are stamped into `user_metadata` on the auth user and read
    later by [auth.js](netlify/functions/auth.js:77) on first profile creation.

### 3.2 `POST ${SUPA_URL}/auth/v1/token?grant_type=refresh_token`
- **File / call site:** [app.js:115](app.js:115) — `refreshSupabaseToken`
- **Type:** Token refresh against Supabase Auth.
- **Who can call it:** The SPA, holding a valid `refresh_token` from
  `localStorage`.
- **Accepts:** `{ refresh_token }` — comes from the browser session blob.

---

## 4. Untrusted LLM output (model responses treated as input)

Anthropic responses are external untrusted text. They flow into the DB, into
the UI, and into the next prompt cycle — so they belong in the input-surface
inventory.

### 4.1 Claude triage response — Sonnet
- **Origin:** Response body from `https://api.anthropic.com/v1/messages` via
  [triage.js](netlify/functions/triage.js:79).
- **Where it goes:**
  - Returned verbatim to the browser (decorated with a server-built `_relai`
    envelope).
  - Client extracts text via `(data.content||[]).map(b => b.text||'').join('')`
    then parses the JSON-in-text payload with `parseTriageJSON` (in
    [data/triage-lib.js](data/triage-lib.js)) — i.e. the model's own JSON is
    parsed and trusted as the canonical triage classification.
  - Normalized via `normalizeTriageOutput`, then persisted into
    `query_history` (draft, severity, clinical_category, non_clinical_items[],
    follow_up_questions[], urgency, review_request{...}).
  - `review_request.confidence` < 0.75 spawns a `review_requests` row that
    can later be promoted into `kb_entries` (active learning loop) —
    meaning **model text can land in the KB**, after staff sign-off.
- **Trust posture:** untrusted; structured fields are enum-normalized, free
  text fields (`draft_response`, `correction_note`) are not sanitized — they
  render in the UI verbatim.

### 4.2 Claude analyzer response — Haiku
- **Origin:** Response body from `https://api.anthropic.com/v1/messages` via
  [analyze.js](netlify/functions/_lib/routes/analyze.js:54).
- **Where it goes:**
  - Returned verbatim to the browser at [app.js:1233](app.js:1233).
  - Text is concatenated and stored on `query_history.correction_note` via the
    `save_actual` POST action (§1.12).
- **Trust posture:** untrusted free text; persisted and rendered.

### 4.3 Future: outbound channel responses
- **Bask:** [bask.js](netlify/functions/bask.js) currently returns 501; once
  wired, the response from `${BASK_API_URL}/messages` is an inbound surface
  (parsed `data.id`, etc.).
- **Intercom outbound:** not implemented; same posture will apply.

---

## 5. Summary table

| # | Entry point | Type | Auth | Tenant scope |
|---|---|---|---|---|
| 1.1 | `POST /ingest` | HTTP webhook | API key (`X-Relai-Api-Key`) | from key |
| 1.2 | `POST /intercom` | Third-party webhook | HMAC signature | env-pinned |
| 1.3 | `POST /bask` | HTTP (stub) | **none** | n/a |
| 1.4 | `worker` | Scheduled (disabled) | **none on HTTP** | n/a |
| 1.5 | `GET /auth/profile` | HTTP | Supabase JWT | self |
| 1.6 | `POST /auth/invite` | HTTP | **none beyond service-key presence** | caller-supplied |
| 1.7 | `POST /auth/signout` | HTTP | optional JWT | self |
| 1.8 | `POST /triage` | HTTP (LLM proxy) | Supabase JWT | n/a |
| 1.9 | `POST /kb/analyze` | HTTP (LLM proxy) | Supabase JWT | n/a |
| 1.10 | `GET\|POST /kb` | HTTP | Supabase JWT | from profile |
| 1.11 | `GET /kb/history*` | HTTP | Supabase JWT | from profile |
| 1.12 | `POST /kb/history` | HTTP | Supabase JWT + role | from profile |
| 1.13 | `GET\|POST /kb/reviews` | HTTP | Supabase JWT + role on resolve | from profile |
| 1.14 | `GET /kb/profile` | HTTP | Supabase JWT | self |
| 1.15 | `GET /kb/handoff-template` | HTTP | Supabase JWT | from profile |
| 1.16 | `GET /kb/categories` | HTTP | Supabase JWT | from profile |
| 1.17 | `GET\|POST /kb/admin/users` | HTTP | `is_admin` | caller's |
| 1.18 | `GET\|POST /kb/admin/categories` | HTTP | `is_super_user` | caller's |
| 1.19 | `GET\|POST /kb/admin/settings` | HTTP | `is_super_user` | caller's |
| 3.1 | `POST /auth/v1/otp` (Supabase) | Public auth | anon key | n/a |
| 3.2 | `POST /auth/v1/token` (Supabase) | Public auth | refresh_token | n/a |
| 4.1 | Claude triage response | LLM output | upstream Anthropic | n/a |
| 4.2 | Claude analyzer response | LLM output | upstream Anthropic | n/a |

---

## 6. Notes on weak / surprising surfaces

These are observations from the audit; no code changes were made.

- **`/auth/invite` has no caller auth check.** It only requires the server
  env-var `SUPABASE_SERVICE_KEY`. Anyone able to reach the URL can create
  Supabase Auth users with `email_confirm:true` and assign them to any
  `company_id` the caller picks. The matching `profile` and `company_members`
  rows are PATCHed with the same caller-supplied role + tenant. This is the
  most exposed admin-equivalent endpoint in the function set.
- **`/.netlify/functions/worker` has no HTTP auth.** It's intended to be
  scheduler-only, but the URL is reachable; anyone could trigger a drain. Low
  damage today (the triage call is stubbed) but worth gating before §1.8 gets
  wired into it.
- **`/.netlify/functions/bask` has no auth.** It's a 501 stub, so the surface
  is currently inert, but when wired it should be locked down to same-origin /
  service-token.
- **LLM responses are persisted unsanitized.** `draft_response` and
  `correction_note` are written to `query_history` verbatim and rendered in
  the staff UI. They're rendered into DOM via assignments elsewhere in
  [app.js](app.js) — if any path uses `innerHTML` for these fields, that's an
  XSS sink fed by Claude output. (Out of scope for this document — flagged for
  separate review.)
- **Intercom's tenant is env-pinned**, so a multi-tenant deployment would
  silently route every Intercom message to whichever company_id is in
  `INTERCOM_TENANT_COMPANY_ID` until the path becomes tenant-keyed.
- **Active learning loop = model → KB.** Triage responses with low confidence
  create `review_requests` rows; resolving them with `context='kb_gap'` or
  `'protocol'` promotes the **staff-edited** answer into `kb_entries`. The
  human in the loop is the trust boundary — a future "auto-resolve" or
  ML-suggested answer would change the threat model.
