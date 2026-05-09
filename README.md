# Relai — Triage and Tasking

AI-assisted clinical triage and task routing for telehealth practices.
Currently single-tenant (Big Easy Weight Loss) trial; architected to
become a multi-tenant SaaS.

> **Working on this codebase?** Read `AGENTS.md` first. It's the rule
> book — every AI session should follow it. The strategic roadmap lives
> in `PLAN.md`.

---

## What it does

Staff paste a patient message; Claude classifies it against a per-tenant
Knowledge Base and returns a structured triage decision: urgency,
clinical category, severity, suggested response draft, and routing
information for non-clinical items. Staff approve / edit / send and
optionally paste back what they actually sent — that becomes a learning
signal that's stored against the triage record.

When the EHR side (Bask Health) is ready, ingestion will be automatic
via webhooks → `ingest.js` → `worker.js` → triage → push response back
through `bask.js`.

---

## Repo layout

```
/                          repo root
├── index.html             SPA shell + tabs (Triage, KB, Help, History)
├── login.html             magic-link landing
├── app.js                 SPA logic (kept monolithic — split deferred)
├── styles.css             class-based styles, CSS variables
├── data/
│   ├── defaults.js        fallback constants (brand, models)
│   ├── triage-lib.js      pure helpers — testable in Node
│   ├── base-prompt.js     system prompt template
│   └── default-kb.js      seed KB (used on first run if DB empty)
├── netlify/
│   └── functions/
│       ├── auth.js        profile + tenant config + invite + signout
│       ├── kb.js          KB / history / reviews / analyze proxy
│       ├── triage.js      Anthropic /v1/messages proxy with allowlist
│       ├── ingest.js      EHR webhook intake (idempotent by external_id)
│       ├── worker.js      background processor for pending rows (stub)
│       └── bask.js        outbound to Bask EHR (stub)
├── migrations/            SQL migrations — single source of DB truth
├── tests/                 plain-Node unit tests (npm test)
├── eval/                  eval harness skeleton for triage regression tests
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
| Auth             | Supabase magic-link                   |
| Hosting          | Netlify                               |

---

## Running locally / making changes

There is no build step today. Edit files directly; Netlify auto-deploys
`main`. To test backend changes locally use `netlify dev`.

```sh
# Run tests
npm test

# Run eval harness (stub — see eval/README.md)
npm run eval
```

---

## Environment variables (set in Netlify → Site Settings → Env Vars)

| Variable               | Used by              | Purpose                                                          |
|------------------------|----------------------|------------------------------------------------------------------|
| `SUPABASE_URL`         | all functions        | PostgREST endpoint                                               |
| `SUPABASE_ANON_KEY`    | all functions        | Public client key (RLS-respecting reads)                         |
| `SUPABASE_SERVICE_KEY` | auth, kb, ingest, worker | Service role key — for writes that bypass RLS where required |
| `ANTHROPIC_API_KEY`    | triage, kb /analyze  | Anthropic API key                                                |
| `BASK_API_URL`         | bask                 | Bask EHR API base URL (when integration goes live)               |
| `BASK_API_KEY`         | bask                 | Bask API token                                                   |

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

1. Staff visit `/login.html` and enter email, first name, department
2. Supabase sends a magic link
3. Clicking the link returns the user with a session token
4. `initAuth()` validates the token, loads profile + tenant config
5. Name and department badge appear in the staff chip (top right)

New users must be created in Supabase Auth by an administrator first.
Public signups are disabled.

---

## Status

Active trial — internal use only. Not for public access.

Built and maintained by Brad Madiuk.
