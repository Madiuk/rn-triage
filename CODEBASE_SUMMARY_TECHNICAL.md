# Care Station — Codebase Summary (Technical)

**Version:** 0.4.2 · **Status:** Active trial, internal use only

## Purpose

AI-assisted customer-service triage and task-routing SPA. Inbound
patient/customer messages arrive through pluggable channels (Intercom
live; EHR/email/SMS/web-form planned), get classified by Claude
against a per-tenant Knowledge Base, and surface as tasks in a shared
pull queue. The queue SPA is the staff home page at `/`; staff pull
tasks, review the AI's draft response in a two-column detail view,
edit and send (or release back to the pool). What's actually sent
feeds back as a learning signal (`edit_distance`,
`session_duration_seconds`); staff overrides of urgency and category
are captured per row.

Single-tenant today (Big Easy Weight Loss, clinical telehealth).
Architected to become a multi-tenant, vertical-agnostic SaaS — channels,
KB, queue, and learning loop are tenant-scoped. Roadmap in
[PLAN.md](PLAN.md); AI-agent rules in [AGENTS.md](AGENTS.md).

## Main Features

- **AI triage** — Claude Sonnet 4.6 with prompt caching → structured
  JSON: `urgency`, `clinical_category`, `non_clinical_items`,
  `routed_to`, `follow_up_questions`, `draft_response`,
  confidence-gated `review_request`.
- **Knowledge Base** — per-tenant, scoped by `company_id`; seeded from
  [data/default-kb.js](data/default-kb.js).
- **Pluggable channel ingest** — generic
  [ingest.js](netlify/functions/ingest.js) (API-key auth, idempotent by
  `external_id`) plus channel adapters
  ([intercom.js](netlify/functions/intercom.js) live;
  [bask.js](netlify/functions/bask.js) outbound stub).
- **Active learning** — `review_requests` resolved as `kb_gap` /
  `protocol` auto-promote into `kb_entries` (`promoteReviewToKB`).
- **Roles, gates, escalation, admin panel** — super-user / admin / user
  tiers; admin manages users, categories, settings.
- **History** — per-row delete with context confirmation, paginated
  (page-size 10/25/50/100/all), prev/next at top and bottom.
- **Reward signals** — Levenshtein `edit_distance` (AI draft → sent) +
  `session_duration_seconds` per row.
- **Magic-link auth** — Supabase; JWT auto-refresh on stale sessions;
  admin-provisioned users only.
- **Corrections** — Claude Haiku 4.5 for low-cost rewrites.

## Tech Stack

| Layer            | Choice                                     |
|------------------|--------------------------------------------|
| Frontend         | Vanilla HTML + CSS + ES2017 JS (SPA)       |
| AI — triage      | Claude Sonnet 4.6 (prompt cache)           |
| AI — corrections | Claude Haiku 4.5                           |
| Backend          | Netlify Serverless Functions (Node ≥ 18)   |
| Database         | Supabase (Postgres + RLS)                  |
| Auth             | Supabase email + password                  |
| Hosting          | Netlify (auto-deploys `main`)              |

No build step. `npm test` runs plain-Node unit + contract tests;
`npm run eval` runs the triage regression harness against current
`BASE_PROMPT` + `DEFAULT_KB`.

## Main Files

**Tasking SPA (site default)**
- [index.html](index.html) — Tasking SPA shell. Queue + detail views, hash routing (`#queue`, `#task/<id>`, `#events`).
- [tasking.js](tasking.js) — Tasking SPA logic.
- [tasking-helpers.js](tasking-helpers.js) — Pure helpers, Node-testable.
- [tasking-styles.css](tasking-styles.css) — Tasking SPA styles.

**Legacy paste-and-triage SPA (super-user fallback)**
- [manual.html](manual.html) — Legacy SPA shell. Hidden from non-super-users; reached via the profile-panel "Manual paste (legacy)" link.
- [app.js](app.js) — Legacy SPA logic (monolithic; split deferred).
- [styles.css](styles.css) — Legacy SPA styles.

**Shared**
- [login.html](login.html) — email + password sign-in; password-reset and accept-invite flows redirect to dedicated pages.

**Shared data / pure helpers**
- [data/defaults.js](data/defaults.js) — fallback constants (brand, model IDs, confidence threshold).
- [data/triage-lib.js](data/triage-lib.js) — pure helpers, Node-testable.
- [data/base-prompt.js](data/base-prompt.js) — system-prompt template.
- [data/default-kb.js](data/default-kb.js) — seed KB.

**Netlify functions** (`netlify/functions/`) — **thin-router pattern as of v0.4.0**
- [auth.js](netlify/functions/auth.js) — profile + tenant config + invite + signout.
- [kb.js](netlify/functions/kb.js) — thin router; dispatches by path to `_lib/routes/*` (KB CRUD, history, reviews, analyze, admin, admin-events, profile).
- [queue.js](netlify/functions/queue.js) — pull-queue actions (`pull`/`mine`/`retask`/`reassign`/`send`/`vote`); public path `/queue/<action>` via redirect.
- [triage.js](netlify/functions/triage.js) — Anthropic `/v1/messages` proxy with model allowlist.
- [ingest.js](netlify/functions/ingest.js) — generic inbound webhook (`X-Relai-Api-Key`), idempotent.
- [worker.js](netlify/functions/worker.js) — background processor for pending rows; scheduled every 4h plus manual fire from the tasking SPA.
- [intercom.js](netlify/functions/intercom.js) — Intercom inbound webhook (HMAC-verified).
- [bask.js](netlify/functions/bask.js) — Bask Health outbound adapter (stub).
- [sla-sweep.js](netlify/functions/sla-sweep.js) — operator-triggered SLA sweep (not scheduled).

**Server shared lib** (`netlify/functions/_lib/`)
- `auth.js`, `db.js`, `permissions.js`, `supabase.js`, `history-aggregations.js`
- `routes/` — `kb-crud.js`, `history.js`, `reviews.js`, `analyze.js`, `admin.js`, `profile.js`

**Database** ([migrations/](migrations/), 0001–0025)
- `profiles`, `companies`, `tenants`, `kb_entries`, `query_history`,
  `review_requests`, `audit_log`, `api_keys`, `category_metadata`,
  `inbound_raw_event`. Append-only, idempotent SQL files. 0011–0019
  add an explicit RLS deny baseline on `query_history` plus CHECK
  constraints on its enum columns, with allowlists kept in sync with
  code via source-text contract tests. 0024 introduces the
  `inbound_raw_event` audit log. 0025 narrows `urgency_override` to
  three values aligned with the tasking SPA's dropdown.

**Tests** ([tests/](tests/)) — 785 individual checks covering pure
helpers, route contracts, role gates, permissions, KB promotion,
Intercom HMAC, triage proxy, `/auth/invite` auth gate, first-admin
bootstrap, urgency-score call sites, parse/normalize/classify, DB ↔
code allowlist parity for the CHECK constraints, and the tasking
SPA's helper modules.

**Eval** ([eval/](eval/)) — 13 case fixtures including
`anaphylaxis`, `panc`, `dehydration`, `hypoglycemia`, `missed-dose`,
`prior-context`, `low-confidence`, `billing-only`, `general-hours`.

**Docs**
- [README.md](README.md) — setup, env vars, schema overview.
- [ARCHITECTURE.md](ARCHITECTURE.md) — URL routing, function map, external services.
- [AGENTS.md](AGENTS.md) — rules for AI agents working on the repo.
- [PLAN.md](PLAN.md) — multi-tenant / channel-framework roadmap.
- [CHANGELOG.md](CHANGELOG.md) — version history.

## Recent Direction

**Tasking SPA promoted to site default (2026-05-17).** The pull-queue
SPA (formerly at `/tasking.html`) now serves at `/`. The legacy
paste-and-triage SPA moved to `/manual.html` and is super-user-only;
it remains functional for occasional ad-hoc queries by the operator.
A 301 redirect at `/tasking.html` preserves pre-rename bookmarks.
Same-week additions to the tasking detail view: editable urgency
dropdown (3 values — Routine / Same Day / Urgent — wired to the
existing `update_urgency` action), single source for category +
pencil (consolidated into the AI-classification section), Intercom
channel chip pushed to the far right of the top bar, AI confidence
hidden from the detail view (still captured server-side).
`urgency_override` allowlist narrowed from five values to three
(migration 0025; dropped legacy `24h` and `24-72h`).

**Earlier:** v0.4.0 split the monolithic `kb.js` Netlify function
into a thin router + 6 route modules under `_lib/routes/`, added
server-side tests, and introduced a triage-path contract test.
v0.4.1 fixed a sign-out race and removed the Activity section.

Subsequent v0.4.x hardening pass: three audits compiled
([RELAI_INPUT_SURFACES.md](RELAI_INPUT_SURFACES.md),
[RELAI_VALIDATION_AUDIT.md](RELAI_VALIDATION_AUDIT.md),
[RELAI_DB_INTEGRITY_AUDIT.md](RELAI_DB_INTEGRITY_AUDIT.md));
`/auth/invite` closed against unauthenticated tenant takeover; first-
admin bootstrap wired so fresh tenants don't need a manual
post-migration SQL UPDATE; `query_history` enum CHECK constraints +
explicit RLS deny baseline landed (migrations 0011–0014); three
remaining HIGH-rank findings (`/triage` body validation, cross-
cutting rate limiting, AI output semantic trust) tracked in
[PLAN.md](PLAN.md) "Security backlog" with explicit triggers and
fix shapes — none urgent for the single-tenant trial.

The legacy [app.js](app.js) (loaded by `manual.html`) remains
monolithic; split deferred per [AGENTS.md](AGENTS.md). Going forward,
new feature work targets the tasking SPA ([tasking.js](tasking.js))
rather than `app.js`.
