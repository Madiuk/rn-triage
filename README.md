# Relai — Triage and Tasking

AI-assisted clinical triage and task routing for telehealth practices. 

---

## What It Does

Relai helps clinical and non-clinical staff process patient messages faster and more consistently. Staff paste a patient message, the AI classifies it, generates a draft response, and routes any non-clinical items (billing, shipment, etc.) to the right support team — all in one step.

Over time, Relai learns from staff corrections and builds a confidence model that could eventually support auto-replies for routine inquiries.

---

## Key Features

- **AI Triage** — classifies patient messages by urgency, clinical category, and task type
- **Dual Task Detection** — identifies messages with both clinical and non-clinical components and handles each appropriately
- **Routing Cards** — generates internal notes for support team handoffs (Bask integration)
- **Clinical Knowledge Base** — staff-maintained protocols, side effect guidance, templates, and routing rules that the AI reads on every triage
- **Learning Loop** — staff paste what they actually sent; the AI compares drafts to corrections and generates learning notes
- **Severity Validation** — staff confirm or flag the AI's side effect severity classification to improve future accuracy
- **AI Review Queue** — when the AI's confidence is below threshold, it flags the triage for clinical expert review; answers feed back into the knowledge base
- **Magic Link Auth** — passwordless login via Supabase, no passwords to manage
- **Staff Attribution** — all triages, KB entries, and corrections are attributed to the logged-in user
- **Multi-tenancy Ready** — company-scoped data, RLS policies, and role-based identity (Clinical / Non-Clinical)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript — no framework |
| AI Model | Claude Haiku 4.5 via Anthropic API |
| Backend | Netlify Serverless Functions (Node.js) |
| Database | Supabase (PostgreSQL + RLS) |
| Auth | Supabase Magic Link (passwordless) |
| Hosting | Netlify |
| Version Control | GitHub |

---

## Project Structure

```
rn-triage/
├── index.html                  # HTML structure
├── app.js                      # All application logic (~103KB)
├── styles.css                  # All styles (~20KB)
├── login.html                  # Magic link auth page
└── netlify/
    └── functions/
        ├── auth.js             # Profile management, invite, signout
        ├── kb.js               # Knowledge base CRUD, history, corrections, reviews
        ├── triage.js           # Anthropic API proxy
        └── ingest.js           # Webhook ingest (Bask integration stub)
```

---

## Database Schema (Supabase)

| Table | Purpose |
|---|---|
| `profiles` | User profiles — name, role, company |
| `companies` | Tenant companies |
| `company_members` | User ↔ company membership |
| `kb_entries` | Knowledge base entries per section |
| `query_history` | Triage records with full AI output and corrections |
| `review_requests` | AI-flagged items needing clinical expert input |
| `api_keys` | Webhook API keys (hashed) |

---

## Netlify Environment Variables

Set these in Netlify → Site Settings → Environment Variables:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Public anon key (safe for client use) |
| `SUPABASE_SERVICE_KEY` | Service role key (server-side only, bypasses RLS) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |

---

## Knowledge Base Sections

The AI reads relevant KB sections on every triage based on message classification:

| Section | Contents |
|---|---|
| **Side Effects** | Education and management guidance for GLP-1 side effects |
| **Templates** | Response frameworks for common message types |
| **Protocols** | If/then clinical decision logic |
| **Rules & Notes** | Urgency thresholds, severity rules, system behavior |
| **Routing** | When and how to escalate or route to support |
| **URLs** | Reference links used in patient responses |

---

## AI Triage Output

Each triage returns a structured JSON response:

```json
{
  "non_clinical_flag": true,
  "non_clinical_items": ["Shipment/Tracking"],
  "routed_to": "Shipping & Fulfillment",
  "internal_note": "Patient reports shipment not arrived...",
  "clinical_routing_flag": true,
  "clinical_routing_level": "moderate",
  "clinical_category": "Side Effects",
  "urgency": "Same Day",
  "follow_up_questions": [],
  "draft_response": "I hear you — those symptoms sound uncomfortable...",
  "review_request": {
    "question": "Patient described symptoms consistent with RLS — should this escalate to severe?",
    "context": "severity",
    "confidence": 0.61
  }
}
```

`review_request` is only populated when the AI's confidence falls below 0.75 on a clinical decision.

---

## Auth Flow

1. Staff visit `/login.html` and enter email, first name, and department
2. Supabase sends a magic link to their email
3. Clicking the link returns them to the app with a session token
4. `initAuth()` validates the token and loads their profile from Supabase
5. Name and department badge appear in the staff chip (top right)

New users must be added to Supabase Auth by an administrator before they can receive a magic link. Public signups are disabled.

---

## Learning System

Every triage captures:
- AI draft vs what was actually sent (correction delta)
- Category corrections made by staff
- Severity validation (correct / incorrect)
- Timeframe overrides
- Thumbs up / thumbs down on response quality
- Session duration
- Staff identity (user ID)

When staff submit a correction, Claude Haiku compares the AI draft to what was sent and generates a learning note that gets stored against the triage record.

The AI Review Queue surfaces cases where the AI was uncertain, letting clinical leads answer specific questions that feed back into the KB or correction history.

---

## Deployment

1. Push to GitHub — Netlify deploys automatically on push to `main`
2. Netlify functions deploy from `netlify/functions/`
3. Run database migrations in Supabase SQL Editor as needed

---

## Status

Active trial — internal use only. Not for public access.

Built and maintained by Brad Madiuk
