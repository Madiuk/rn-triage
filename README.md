# Care Station — Triage and Tasking

AI-assisted customer-service triage and task routing — categorizes
inbound patient/customer messages, drafts a reply, and surfaces what
needs to go to which team. Currently single-tenant (Big Easy Weight
Loss, a clinical telehealth practice); architected to become a
multi-tenant SaaS that's vertical-agnostic — the next tenant could be
another medical practice or something completely different (auto
service, property management, etc.). See `PLAN.md` for the readiness
audit on what's still vertical-shaped today.

> **Working on this codebase?** Read `AGENTS.md` first. It's the rule
> book — every AI session should follow it. The strategic roadmap lives
> in `PLAN.md`.

---

## What it does

Patient messages arrive through pluggable **channels** — Intercom is
live today; EHR webhooks (Bask Health, Healthie), forwarded email,
SMS, and web forms are planned. Each inbound message lands in
`query_history` as `pending`, then `worker.js` runs it through Claude
against the tenant's Knowledge Base and writes back a structured
triage decision: urgency, clinical category, routing level, and a
drafted response. Triaged rows surface in the **tasking queue**, the
staff-facing SPA at `/`.

Staff pull tasks from the queue, review the AI's draft in a two-column
detail view, edit and send (or release back to the pool). What they
actually send feeds back as a learning signal (`edit_distance`,
`session_duration_seconds`); staff overrides of the AI's urgency or
category are captured per row. Triage, KB, queue, and learning are
channel-agnostic. See `PLAN.md` Phase 3 for the channel framework
design.

A legacy paste-a-message SPA at `/manual.html` remains available for
the super-user to run occasional ad-hoc queries; it's hidden from
other staff and is not part of the production flow.

---

## Repo layout

```
/                          repo root
├── index.html             Tasking SPA shell — the site default at /.
│                          Queue view + full-page detail view; hash
│                          routing (#queue, #task/<id>, #events).
├── tasking.js             Tasking SPA logic.
├── tasking-helpers.js     Pure helpers (Node-testable) used by tasking.js.
├── tasking-styles.css     Tasking SPA styles.
├── manual.html            Legacy paste-and-triage SPA. Super-user only;
│                          reached via the profile-panel link. Kept for
│                          occasional ad-hoc queries by the super-user
│                          (it pre-dates the tasking system).
├── app.js                 Legacy SPA logic (loaded by manual.html).
├── styles.css             Legacy SPA styles (loaded by manual.html).
├── login.html             Magic-link landing.
├── data/
│   ├── defaults.js        fallback constants (brand, models, thresholds)
│   ├── triage-lib.js      pure helpers — testable in Node
│   ├── base-prompt.js     system prompt template
│   └── default-kb.js      seed KB (used on first run if DB empty)
├── netlify/
│   └── functions/
│       ├── auth.js        profile + tenant config + invite + signout
│       ├── kb.js          KB / history / reviews / analyze / admin
│       │                  thin router; route modules in _lib/routes/
│       ├── queue.js       Pull-queue actions (pull/mine/retask/reassign/
│       │                  send/vote) — exposed at /queue/* via rewrite
│       ├── triage.js      Anthropic /v1/messages proxy with allowlist
│       ├── ingest.js      Generic inbound webhook (any channel with
│       │                  an X-Relai-Api-Key); idempotent by external_id
│       ├── worker.js      Background processor for pending rows
│       │                  (scheduled every 4h + manual fire button)
│       ├── intercom.js    Intercom channel adapter (inbound webhook,
│       │                  HMAC-verified; outbound deferred)
│       ├── bask.js        Bask Health channel adapter (outbound) — stub
│       └── sla-sweep.js   Operator-triggered SLA sweep (not scheduled)
├── migrations/            SQL migrations — single source of DB truth
├── tests/                 plain-Node unit tests (npm test)
├── eval/                  eval harness skeleton for triage regression tests
├── ARCHITECTURE.md        URL routing, function map, external services
├── AGENTS.md              project rules for AI agents
├── PLAN.md                strategic roadmap
└── README.md              this file
```

---

## Tech stack

| Layer            | Choice                                |
|------------------|---------------------------------------|
| Frontend         | Vanilla HTML + CSS + ES2017 JS        |
| AI — triage      | Claude Sonnet 4.6 (with prompt cache) |
| AI — corrections | Claude Haiku 4.5                      |
| Backend          | Netlify Serverless Functions (Node)   |
| Database         | Supabase (Postgres + RLS)             |
| Auth             | Supabase email + password             |
| Hosting          | Netlify                               |

---

## Running locally / making changes

There is no build step today. Edit files directly; Netlify auto-deploys
`main`. To test backend changes locally use `netlify dev`.

```sh
# Run tests
npm test

# Run eval harness against current BASE_PROMPT + DEFAULT_KB. Direct
# Anthropic call by default (needs ANTHROPIC_API_KEY); add
# --endpoint <url> to route through a deployed triage proxy instead.
# See eval/README.md for full options.
ANTHROPIC_API_KEY=sk-ant-... npm run eval
```

---

## Environment variables (set in Netlify → Site Settings → Env Vars)

| Variable               | Used by              | Purpose                                                          |
|------------------------|----------------------|------------------------------------------------------------------|
| `SUPABASE_URL`         | all functions        | PostgREST endpoint                                               |
| `SUPABASE_ANON_KEY`    | all functions        | Public client key (RLS-respecting reads)                         |
| `SUPABASE_SERVICE_KEY` | auth, kb, ingest, worker | Service role key — for writes that bypass RLS where required |
| `ANTHROPIC_API_KEY`    | triage, kb /analyze  | Anthropic API key                                                |

**Channel-specific env vars** (per-tenant config — currently held in
global env vars while there's only one tenant; will move into the
`tenants.channels` jsonb column in Phase 3).

| Variable                       | Used by                  | Purpose                                                                |
|--------------------------------|--------------------------|------------------------------------------------------------------------|
| `BASK_API_URL`                 | bask channel adapter     | Bask Health API base URL (Big Easy Weight Loss only)                   |
| `BASK_API_KEY`                 | bask channel adapter     | Bask Health API token (Big Easy Weight Loss only)                      |
| `INTERCOM_WEBHOOK_SECRET`      | intercom channel adapter | Shared secret Intercom signs webhook payloads with (HMAC SHA-1/256)    |
| `INTERCOM_TENANT_COMPANY_ID`   | intercom channel adapter | Single-tenant: company_id to attribute Intercom-ingested rows to       |
| `INTERCOM_ACCESS_TOKEN`        | intercom (outbound, TBD) | Intercom API token for posting replies back to conversations           |
| `INTERCOM_ADMIN_ID`            | intercom (outbound, TBD) | Which Intercom admin is recorded as sending the reply                  |

### Intercom webhook setup

Once Intercom is configured to send webhooks to
`https://<your-carestation-domain>/.netlify/functions/intercom`, the
adapter accepts the two user-message topics (`conversation.user.created`
and `conversation.user.replied`) and ignores everything else with a
quiet 200 so Intercom doesn't retry. The webhook URL is the same per
tenant in single-tenant mode; multi-tenant routing comes in Phase 4
when the URL becomes tenant-keyed.

---

## Database

Schema is captured in `migrations/`. To bring up a new environment, run
the SQL files in numeric order in Supabase's SQL Editor. New schema
changes go in a new file (`migrations/0005_*.sql` etc.) — never edit a
previous migration.

Key tables:
- `profiles` — Supabase Auth users + name/role/company
- `companies` — tenant orgs (legacy; will fold into `tenants`)
- `tenants` — per-tenant config (brand, theme, defaults)
- `kb_entries` — knowledge base, scoped by `company_id`
- `query_history` — every triage run + correction + reward signal
- `review_requests` — low-confidence triages flagged for clinical expert
- `audit_log` — append-only event log
- `api_keys` — webhook ingest auth (sha256 hashed)

---

## Active learning

When a clinical expert resolves a `review_requests` row with context
`kb_gap` or `protocol`, the answer is automatically inserted into
`kb_entries` (in section `notes` or `protocols` respectively). This
closes the "AI flagged uncertainty → expert answers → next triage uses
the answer" loop without manual KB editing. See `kb.js`
`promoteReviewToKB`.

Every triage also captures `edit_distance` (Levenshtein from the AI's
draft to what was actually sent) and `session_duration_seconds`. These
are the reward signals for tracking model quality over time.

---

## Triage output JSON

```json
{
  "non_clinical_flag": true,
  "non_clinical_items": ["Shipment/Tracking"],
  "routed_to": "Shipping & Fulfillment",
  "internal_note": "Patient reports shipment not arrived...",
  "clinical_routing_flag": true,
  "clinical_routing_level": "moderate",
  "clinical_category": "Side Effects",
  "urgency": "same-day",
  "follow_up_questions": [],
  "draft_response": "I hear you — those symptoms sound uncomfortable...",
  "review_request": {
    "question": "Patient described symptoms consistent with X — should this escalate?",
    "context": "severity",
    "confidence": 0.61
  }
}
```

`review_request` is only populated when the AI's confidence falls below
the threshold (0.75 by default; see `data/defaults.js`).

---

## Auth flow

1. Staff visit `/login.html` and enter email + password
2. Supabase validates via `/auth/v1/token?grant_type=password` and returns a session JWT
3. The SPA stores the session in `localStorage` (`relai_session`) and loads profile + tenant config via `initAuth()`
4. Name and department badge appear in the staff chip (top right)
5. **Forgot password?** sends a recovery link (handled at `/reset-password.html`)

New users must be invited by an admin; the invite email lands at `/accept-invite.html` where the user sets an initial password. Public signups are disabled. Magic-link sign-in was retired in Phase 4.

---

## Status

Active trial — internal use only. Not for public access.

Built and maintained by Brad Madiuk.

