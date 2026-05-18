# Architecture Inventory — Care Station

Reference for the project's URL routing, function map, and external
integrations. Generated from a read-only walk of the working tree on
2026-05-17 and updated in place as the architecture shifts.

The repo on disk still uses the name "relai" (e.g. in
[package.json](package.json), `relai_session` localStorage keys, the
"Relai..." filenames at the project root). Product was renamed to
Care Station; that rename has not yet been propagated through the code.

**As of 2026-05-17, the tasking SPA has been promoted to the site
default at `/`.** The legacy paste-and-triage SPA was moved to
`/manual.html` and is super-user-only (hidden from other staff via
the profile-panel gate). A 301 redirect at `/tasking.html` preserves
pre-rename bookmarks. Going forward, new feature work targets the
tasking SPA (`tasking.js`); the legacy SPA (`app.js` + `manual.html`)
is kept reachable for the operator's occasional ad-hoc queries and
is not part of the production staff flow.

---

## Entry Points

### Static HTML pages (served by Netlify CDN at the site root)

There is no SPA router — each `.html` is a separately addressable
page. Within each page, in-page navigation is by tab-button (no URL
changes) or by hash fragment.

| Path | File | Invocation |
| --- | --- | --- |
| `/` (default) and `/index.html` | [index.html](index.html) + [tasking.js](tasking.js) + [tasking-helpers.js](tasking-helpers.js) + [tasking-styles.css](tasking-styles.css) | User navigation — the staff home page. Pull-queue SPA ("Tasking Queue"). Hash-based in-page routing: `#queue` (default), `#task/<id>` (detail view), `#events` (super-user Event Log). Set via `window.location.hash` in [tasking.js](tasking.js); the "Event Log" view is gated to super-users in JS at init. |
| `/login.html` | [login.html](login.html) | User navigation (redirected here by [app.js:186](app.js:186), [app.js:391](app.js:391), [app.js:431](app.js:431), [app.js:551](app.js:551), and [tasking.js](tasking.js) when no valid session is present). Submits the email + password form to Supabase Auth's `/auth/v1/token?grant_type=password` directly ([login.html:345](login.html:345)) — see "External Services". Also the initial landing page for Supabase recovery and invite email links: the hash handler at [login.html:213-232](login.html:213) inspects the `type` URL fragment and redirects `recovery` → `/reset-password.html` and `invite` → `/accept-invite.html`; any stale magic-link / signup tokens are rejected (Phase 4 retirement). |
| `/manual.html` | [manual.html](manual.html) + [app.js](app.js) + [styles.css](styles.css) | Super-user-only legacy SPA ("Patient Inquiry & Tasking"). Hidden from other staff via the profile-panel link gate in [tasking.js](tasking.js) (`manualLinkBtn` is `display:none` until `applyProfileUI()` checks `is_super_user`). Internal tabs (no URL change) toggled by `switchTab(name, btn)` in [app.js:1057](app.js:1057): `triage`, `kb`, `help`, `worklist`, `history`, `admin`. Reads static data modules from `data/` (`base-prompt.js`, `default-kb.js`, `defaults.js`, `triage-lib.js`) loaded as plain `<script>` tags. Pre-dates the tasking system; retained for occasional ad-hoc queries by the operator. |
| `/tasking.html` (legacy) | 301 → `/` | Preserved for pre-rename bookmarks. Defined in [netlify.toml](netlify.toml) as a 301 redirect to the site root. |
| `/demo.html` | [demo.html](demo.html) + [demo.js](demo.js) + [demo-styles.css](demo-styles.css) + [demo-data.json](demo-data.json) | User navigation. Standalone demo SPA with fabricated data only; no backend calls. Internal navigation uses `data-view` attributes (`queue`, `preferences`, `training`) — see [demo.html:30-33](demo.html:30) and [demo.js:547](demo.js:547). |

### Netlify Functions

All live under `netlify/functions/`. The build config
([netlify.toml:8-9](netlify.toml:8)) bundles them with esbuild. Default
public URL is `/.netlify/functions/<filename>` unless a redirect
rewrites it.

| File | Public path(s) | Methods | Invocation |
| --- | --- | --- | --- |
| [auth.js](netlify/functions/auth.js) | `/.netlify/functions/auth/profile`, `/auth/invite`, `/auth/signout` | GET (profile), POST (invite, signout) | Called by the SPAs ([app.js](app.js), [tasking.js](tasking.js)) over `fetch('/.netlify/functions/auth/...')`. Dispatch is by substring match on `event.path` ([auth.js:48](netlify/functions/auth.js:48), [auth.js:199](netlify/functions/auth.js:199), [auth.js:341](netlify/functions/auth.js:341)). `/profile` runs on every session init; `/invite` runs from the Admin tab; `/signout` runs on Sign Out. |
| [bask.js](netlify/functions/bask.js) | `/.netlify/functions/bask` | POST | Outbound channel adapter for Bask Health EHR. Stub today — returns 501 ([bask.js:76-83](netlify/functions/bask.js:76)). Per header comment, expected to be called server-side only with `{ triage_id, response_text, thread_external_id }`. No caller in the current codebase invokes it. |
| [ingest.js](netlify/functions/ingest.js) | `/.netlify/functions/ingest` | POST | Generic inbound webhook from any external channel. Authenticated by `X-Relai-Api-Key` header (hashed and looked up in `api_keys` table). No caller in this repo — invoked by external services that issue keys. |
| [intercom.js](netlify/functions/intercom.js) | `/.netlify/functions/intercom` | POST | Inbound webhook from Intercom. HMAC signature verification against `INTERCOM_WEBHOOK_SECRET` ([intercom.js:311](netlify/functions/intercom.js:311)). Topics handled: `conversation.user.created`, `conversation.user.replied` ([intercom.js:345](netlify/functions/intercom.js:345)). |
| [kb.js](netlify/functions/kb.js) | `/.netlify/functions/kb/*` (thin router) | Varies per sub-route | SPA calls. Dispatch by substring match on path ([kb.js:47-63](netlify/functions/kb.js:47)) to handlers in `_lib/routes/`. Sub-routes enumerated below. |
| [queue.js](netlify/functions/queue.js) | Direct: `/.netlify/functions/queue/<action>`. Clean (via redirect): `/queue/<action>` | GET (`/mine`), POST (others) | Called by [tasking.js](tasking.js). Rewrite from `/queue/*` to the function path is in [netlify.toml:15-19](netlify.toml:15). Dispatches to `_lib/routes/queue.js` handlers — `pull`, `retask`, `reassign`, `send`, `vote`, `mine` ([queue.js:37-42](netlify/functions/queue.js:37)). |
| [sla-sweep.js](netlify/functions/sla-sweep.js) | `/.netlify/functions/sla-sweep` | Any (handler ignores method) | The header comment says "not scheduled yet… function is invokable manually via HTTP" ([sla-sweep.js:39-40](netlify/functions/sla-sweep.js:39)). No caller in this repo; no scheduled-function entry in [netlify.toml](netlify.toml). Today this is operator-triggered only. |
| [triage.js](netlify/functions/triage.js) | `/.netlify/functions/triage` | POST | Authenticated Anthropic proxy for the live triage flow. Called from [app.js](app.js) (legacy `/manual.html` SPA) during the "Analyze" action. The tasking SPA does not call this directly — it relies on [worker.js](netlify/functions/worker.js) for triage. Auth is a Supabase JWT in `Authorization: Bearer`. |
| [worker-background.js](netlify/functions/worker-background.js) | `/.netlify/functions/worker-background` | POST (also accepts GET; the `-background` suffix makes it a Netlify background function — 202 Accepted immediately, runs up to 15 min) | Two invocation paths: (1) Netlify scheduled function on cron `0 */4 * * *` (every 4 hours) — see [netlify.toml](netlify.toml). (2) Fired by the "Fetch & triage" button in the tasking SPA. Pulls up to 5 oldest `pending` rows, runs each through the triage pipeline, writes results. Renamed from `worker.js` 2026-05-17 to escape the 10s sync timeout that was killing manual batches. |

### Sub-routes dispatched by `kb.js` (handlers in `_lib/routes/`)

`kb.js` is a thin router; the actual handlers live one level down.
Each handler enforces its own auth, role, and tenant scoping.

| Sub-route | Method(s) | Handler | Notes |
| --- | --- | --- | --- |
| `/kb` (exact match) | GET, POST | [_lib/routes/kb-crud.js](netlify/functions/_lib/routes/kb-crud.js) `handle()` | GET returns tenant KB; POST replaces it via DELETE-then-INSERT atomically. Auth required. |
| `/history/stats` | GET | [_lib/routes/history.js](netlify/functions/_lib/routes/history.js) `handle()` | Today/week/total triage counts for the calling user. |
| `/history/cost` | GET | _lib/routes/history.js | Last-N-days spend + model split + cache hit rate. |
| `/history/quality` | GET | _lib/routes/history.js | Calibration + correction signals. |
| `/history/all` | GET | _lib/routes/history.js | Up to 200 most recent rows for the tenant. |
| `/history` (default) | GET | _lib/routes/history.js | Corrections feed (rows with `actual_response_sent` or `correction_note` set). |
| `/history` (default) | POST | _lib/routes/history.js | Action dispatcher: `update_urgency`, `update_category`, `upvote`, `downvote`, `save_actual`, `mark_escalated`, `delete_entry`, or default insert. |
| `/reviews` | GET, POST | [_lib/routes/reviews.js](netlify/functions/_lib/routes/reviews.js) `handle()` | GET lists tenant `review_requests`. POST actions: `create`, `resolve`, `dismiss`. Resolves can promote answers into `kb_entries`. |
| `/analyze` | POST | [_lib/routes/analyze.js](netlify/functions/_lib/routes/analyze.js) `handle()` | Anthropic proxy for the Haiku-based correction analyzer. Model allowlist + max_tokens cap. |
| `/admin/users` | GET, POST | [_lib/routes/admin.js](netlify/functions/_lib/routes/admin.js) `handleUsers()` | Admin-flag-gated. Lists tenant users; `update_role` action. |
| `/admin/categories` | GET, POST | _lib/routes/admin.js `handleCategories()` | Super-user-gated. Read/update tenant category metadata. |
| `/admin/settings` | GET, POST | _lib/routes/admin.js `handleSettings()` | Super-user-gated. Reads tenant; `update_handoff_template` action. |
| `/admin/events/inbound` | GET | [_lib/routes/admin-events.js](netlify/functions/_lib/routes/admin-events.js) `handleInbound()` | Super-user-gated. Reads `inbound_raw_event`. |
| `/admin/events/reviews` | GET | _lib/routes/admin-events.js `handleReviews()` | Super-user-gated. Reads `query_history` rows with `status='reviewed'`. |
| `/admin/events/errors` | GET | _lib/routes/admin-events.js `handleErrors()` | Super-user-gated. Reads `audit_log` rows whose `event_type` is in a failure allowlist. |
| `/handoff-template` | GET | [_lib/routes/profile.js](netlify/functions/_lib/routes/profile.js) `handleHandoffTemplate()` | Reads tenant `non_clinical_handoff_template` from `companies`. |
| `/categories` | GET | _lib/routes/profile.js `handleCategories()` | Reads active `category_metadata` for tenant. Note: not currently consumed by the UI (per the comment at [profile.js:21-23](netlify/functions/_lib/routes/profile.js:21)). |
| `/profile` | GET | _lib/routes/profile.js `handleProfile()` | Caller's own profile row. |

### Sub-routes dispatched by `queue.js`

All handlers live in [_lib/routes/queue.js](netlify/functions/_lib/routes/queue.js).
The public paths via Netlify's redirect are `/queue/<action>`.

| Sub-route | Method | Handler |
| --- | --- | --- |
| `/queue/pull` | POST | `handlePull` ([queue.js:434](netlify/functions/_lib/routes/queue.js:434)) |
| `/queue/mine` | GET | `handleMine` ([queue.js:558](netlify/functions/_lib/routes/queue.js:558)) |
| `/queue/retask` | POST | `handleRetask` ([queue.js:575](netlify/functions/_lib/routes/queue.js:575)) |
| `/queue/reassign` | POST | `handleReassign` ([queue.js:633](netlify/functions/_lib/routes/queue.js:633)) |
| `/queue/send` | POST | `handleSend` ([queue.js:790](netlify/functions/_lib/routes/queue.js:790)) |
| `/queue/vote` | POST | `handleVote` ([queue.js:892](netlify/functions/_lib/routes/queue.js:892)) |

### Supabase edge functions

**None.** A search for `supabase/functions` directories, `*.toml`
config files outside `netlify.toml`, and Deno-style edge-function
imports turned up nothing. All server logic lives in Netlify
Functions.

### GraphQL resolvers

**None.** No `*.graphql` files, no resolver code, no Apollo/Yoga/etc.
imports. The Healthie EHR uses GraphQL externally, but this repo does
not yet integrate with Healthie (only mentioned as a future channel
in `ingest.js` comments and `dispatchOutbound`'s switch in `queue.js`).

### Webhook handlers (summary)

Of the entry points listed above, these are the ones receiving inbound
HTTP calls from external services:

- [intercom.js](netlify/functions/intercom.js) — Intercom platform webhook (HMAC-verified)
- [ingest.js](netlify/functions/ingest.js) — generic external API caller (API-key authenticated)
- [bask.js](netlify/functions/bask.js) — listed for completeness but is stubbed outbound, not a webhook receiver today (header comment notes a future inbound TODO when the Bask contract is published)

---

## External Services

Services that call **into** this codebase, or that this codebase calls
**out to**. The clear distinction matters because the task spec asked
specifically about inbound landings; outbound integrations are listed
for completeness.

### Inbound — services that call into the code

| Service | Lands at | Authentication | Notes |
| --- | --- | --- | --- |
| **Intercom** (live chat webhooks) | [netlify/functions/intercom.js](netlify/functions/intercom.js) (POST) | HMAC SHA256 (or SHA1) signature in `X-Hub-Signature-256` / `X-Hub-Signature`, verified against `INTERCOM_WEBHOOK_SECRET`. | Inserts inbound user messages into `query_history` with `status='pending'`. Audit-trails every received event into `inbound_raw_event` regardless of whether a triage row was created. |
| **Generic API consumers** | [netlify/functions/ingest.js](netlify/functions/ingest.js) (POST) | `X-Relai-Api-Key` header. Hash-matched against `api_keys` table to resolve `company_id`. Rate-limited per key via the `increment_rate_limit` PostgREST RPC. | Tenant-aware. Caller's `channel` field is recorded as `source_channel`; the function does not call Anthropic itself — it just queues the row for `worker.js`. |
| **Supabase Auth (recovery / invite redirect)** | [/login.html](login.html) (GET, browser navigation) | URL fragment (`access_token` + `refresh_token` + `type=recovery\|invite`); not validated server-side. [login.html:213-232](login.html:213) parses the hash and redirects to `/reset-password.html` or `/accept-invite.html` with the hash preserved. | Not a service-to-server call — it's the user-agent following a redirect after Supabase emails the user a password-reset or invite link. Magic-link / signup tokens are explicitly rejected here (Phase 4 retirement). |
| **Netlify scheduler** (cron) | [netlify/functions/worker.js](netlify/functions/worker.js) | Internal — invoked by the Netlify platform, no auth headers. | Configured in [netlify.toml:36-38](netlify.toml:36) on `0 */4 * * *` (every 4h UTC). |
| **Bask Health** (planned inbound) | Not implemented. | n/a | The header comment in [bask.js](netlify/functions/bask.js) and a TODO in [ingest.js](netlify/functions/ingest.js) note that Bask inbound will land here once the vendor contract is published. Today, no Bask code path is wired. |

### Outbound — services this codebase calls

| Service | Called from | Purpose |
| --- | --- | --- |
| **Supabase REST (PostgREST)** at `${SUPABASE_URL}/rest/v1/*` | Every Netlify function. Helper at [_lib/supabase.js](netlify/functions/_lib/supabase.js); per-domain modules at [_lib/db.js](netlify/functions/_lib/db.js), [_lib/auth.js](netlify/functions/_lib/auth.js), [_lib/triage-core.js](netlify/functions/_lib/triage-core.js), every `_lib/routes/*.js`. | Read/write of `query_history`, `profiles`, `companies`, `kb_entries`, `review_requests`, `audit_log`, `inbound_raw_event`, `task_reassignments`, `api_keys`, `category_metadata`, `tenants`, `company_members`. Uses service-key headers for tenant-scoped queries; falls back to anon key + RLS only in narrow cases. |
| **Supabase Auth** at `${SUPABASE_URL}/auth/v1/*` | [auth.js](netlify/functions/auth.js), [_lib/auth.js](netlify/functions/_lib/auth.js), [_lib/routes/admin.js](netlify/functions/_lib/routes/admin.js), [triage.js](netlify/functions/triage.js); also directly from [login.html:345](login.html:345) (`/auth/v1/token?grant_type=password` for sign-in), [login.html:405](login.html:405) (`/auth/v1/recover` for password-reset email), and [data/auth-client.js:73](data/auth-client.js:73) (`/auth/v1/token?grant_type=refresh_token`). | JWT verification, user creation via `/auth/v1/admin/users`, profile-email enrichment, password sign-in, password recovery, token refresh. |
| **Anthropic API** at `https://api.anthropic.com/v1/messages` | [_lib/triage-core.js:152](netlify/functions/_lib/triage-core.js:152) and [_lib/triage-core.js:238](netlify/functions/_lib/triage-core.js:238) (called from [triage.js](netlify/functions/triage.js) and [worker.js](netlify/functions/worker.js)); [_lib/routes/analyze.js:61](netlify/functions/_lib/routes/analyze.js:61). | Triage classification (Claude Sonnet 4.6), correction analysis and optional second-pass safety check (Claude Haiku 4.5). Authenticated via `x-api-key: ${ANTHROPIC_API_KEY}`. |
| **Bask Health API** at `${BASK_API_URL}` | [bask.js](netlify/functions/bask.js) | Outbound channel reply. Stub only — function returns 501 today; real `fetch` is commented out at [bask.js:60-74](netlify/functions/bask.js:60). |
| **Intercom outbound** | Not implemented. | The header comment in [intercom.js:7-15](netlify/functions/intercom.js:7) and the `dispatchOutbound` switch in [_lib/routes/queue.js:775](netlify/functions/_lib/routes/queue.js:775) reserve a slot for it; today the channel branches return a `:stub` success without making a network call (and even that is gated by the `OUTBOUND_LIVE_MODE` kill-switch — see [_lib/safety.js:23-28](netlify/functions/_lib/safety.js:23)). |

### Environment variables consumed

Confirmed by grep across `netlify/functions/`. Source files cited.

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — read in [_lib/supabase.js](netlify/functions/_lib/supabase.js) and most function entry points.
- `ANTHROPIC_API_KEY` — read in [triage.js](netlify/functions/triage.js), [worker.js](netlify/functions/worker.js), [_lib/routes/analyze.js](netlify/functions/_lib/routes/analyze.js).
- `INTERCOM_WEBHOOK_SECRET`, `INTERCOM_TENANT_COMPANY_ID` — [intercom.js:106-107](netlify/functions/intercom.js:106).
- `BASK_API_URL`, `BASK_API_KEY` — [bask.js:35-36](netlify/functions/bask.js:35).
- `OUTBOUND_LIVE_MODE` — [_lib/safety.js:27](netlify/functions/_lib/safety.js:27). Default-off kill-switch for all non-manual outbound dispatch.
- `RELAI_SECOND_PASS_HAIKU` — [_lib/triage-core.js:365](netlify/functions/_lib/triage-core.js:365). Optional toggle for the Haiku second-pass safety check.

---

## Framework & Library Versions

Taken from [package.json](package.json):

```
name:    "relai" (the on-disk name predates the rename to Care Station)
version: "0.4.2"
private: true
engines: node >= 18
scripts: test = "node tests/run.js"
         eval = "node eval/run.js"
```

**There are no declared `dependencies` or `devDependencies`.** This is
not an oversight — the entire codebase runs on Node 18's built-ins:

- `fetch` (Node 18 global) for every outbound HTTP call.
- `crypto` (standard library) for HMAC signature verification in
  [intercom.js](netlify/functions/intercom.js) and SHA-256 hashing of API keys in
  [ingest.js](netlify/functions/ingest.js).
- No client-side framework: [index.html](index.html) (tasking SPA),
  [login.html](login.html), [manual.html](manual.html) (legacy SPA),
  [demo.html](demo.html) all load vanilla JS as plain `<script>`
  tags. No build step on the frontend; no bundler beyond esbuild on
  the function bundle.
- No ORM, no Supabase client SDK — every database call is a raw
  PostgREST URL constructed by hand in the function code.

That means there are no third-party version numbers to record. The
runtime versions that matter are:

- **Node:** `>= 18` (declared in `engines`; provided by the Netlify
  Functions runtime).
- **Anthropic models** (referenced as string identifiers in code,
  not as a library version): `claude-sonnet-4-6` for triage
  ([worker.js:62](netlify/functions/worker.js:62), allowlisted in
  [_lib/triage-core.js](netlify/functions/_lib/triage-core.js)) and
  `claude-haiku-4-5` for correction analysis
  ([_lib/routes/analyze.js:34-35](netlify/functions/_lib/routes/analyze.js:34)).
- **Anthropic API version header:** `anthropic-version: 2023-06-01`
  ([_lib/routes/analyze.js:66](netlify/functions/_lib/routes/analyze.js:66) and
  similarly in triage-core).
- **PostgREST schema version:** managed via SQL migrations in
  [migrations/](migrations/) — the latest migration in the tree is
  `0025_query_history_urgency_override_drop_24h.sql`.

---

## Build & Deploy Config

Everything is in [netlify.toml](netlify.toml). Summary:

### Build

```
[build]
  functions = "netlify/functions"
  ignore    = "git diff --quiet HEAD^ HEAD -- index.html manual.html
               login.html app.js styles.css data/ netlify/ demo.html
               demo.js demo-styles.css demo-data.json tasking.js
               tasking-helpers.js tasking-styles.css"
```

- No bundler/builder for the static site. The HTML/CSS/JS files at
  the project root are deployed verbatim from the working tree.
- The `ignore` clause skips the build entirely if a commit only
  touches files outside the explicitly listed deployable set
  (migrations, tests, eval cases, and root markdown docs do not
  trigger a deploy). Doc-only commits use zero build minutes.

### Functions bundler

```
[functions]
  node_bundler = "esbuild"
```

- Netlify runs esbuild over each entry file in `netlify/functions/`
  to produce the deployed handler. The `_lib/` directory contains
  shared helpers — those are not function entry points themselves;
  they are pulled in by the entry handlers and bundled with them.

### URL rewrites

```
[[redirects]]
  from   = "/queue/*"
  to     = "/.netlify/functions/queue/:splat"
  status = 200
  force  = true

[[redirects]]
  from   = "/tasking.html"
  to     = "/"
  status = 301
  force  = true
```

- The `/queue/*` rule is `status = 200` — a rewrite, not a 301. The
  URL stays `/queue/...` in the browser. This exists so the SPA and
  external callers can use the cleaner `/queue/<action>` path
  instead of `/.netlify/functions/queue/<action>`.
- The `/tasking.html` rule is a 301 — a permanent redirect to the
  site root. Preserves bookmarks from the pre-2026-05-17 period when
  the tasking SPA lived at `/tasking.html` rather than `/`. The
  source file `tasking.html` no longer exists in the repo; only the
  redirect remains.

### Scheduled functions

```
[[scheduled.functions]]
  name     = "worker"
  schedule = "0 */4 * * *"
```

- The only scheduled function is [worker.js](netlify/functions/worker.js),
  every 4 hours at minute 0 UTC (00:00, 04:00, 08:00, 12:00, 16:00,
  20:00). The header comment in `netlify.toml` notes this cadence is
  intentionally conservative for the current sandbox/training phase
  and is expected to tighten to every 15–30 minutes once `OUTBOUND_LIVE_MODE=true`.
- No scheduled entry exists for [sla-sweep.js](netlify/functions/sla-sweep.js)
  today — its header comment confirms it is HTTP-invokable only.

### Hosting platform

- **Netlify.** All static assets and all Netlify Functions are
  served from a single Netlify deploy. No alternate hosting,
  no separate Vercel/Cloudflare/Render configuration is present.
- The custom domain `carestation.app` was purchased on 2026-05-15
  (per the `project_brand_name` memory) but is not referenced in
  any code or config file in this tree.

---

## Items I am uncertain about

- **`/.netlify/functions/sla-sweep` invocation.** The header comment
  says "not scheduled yet… function is invokable manually via HTTP."
  No call to it appears in [app.js](app.js) or [tasking.js](tasking.js).
  There is no `[[scheduled.functions]]` entry for it in
  [netlify.toml](netlify.toml). I am treating it as operator-triggered
  only, but it is possible an external scheduler (a cron job in a
  separate system, a manual ops runbook) hits it on a schedule that
  is not reflected in this repo.

- **`/.netlify/functions/bask`.** The function exists, has full input
  validation, but always returns 501 ([bask.js:76-83](netlify/functions/bask.js:76)).
  No code in the repo calls it. I am classifying it as "exists as a
  reserved entry point but not yet wired" rather than as a live
  endpoint.

- **`/categories` (the user-facing GET, not `/admin/categories`).**
  The handler exists and the route is wired in [kb.js:62](netlify/functions/kb.js:62),
  but the comment at [_lib/routes/profile.js:21-23](netlify/functions/_lib/routes/profile.js:21)
  says "Not yet consumed by the UI." I have listed it as an entry
  point because it is reachable; whether it is dead code is a
  cleanup-pass decision.

- **Whether `/demo.html` is intended to ship to production.** It is
  bundled in the deployable ignore list in [netlify.toml:6](netlify.toml:6),
  which strongly implies "yes." Listed accordingly.
