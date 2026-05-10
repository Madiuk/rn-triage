# PLAN.md — Strategic roadmap

This is the living plan for Relai. Update it when priorities shift.

---

## North star

A multi-tenant SaaS that takes patient messages from any compatible EHR,
triages them with a per-tenant AI model that learns from staff
corrections, and returns validated draft responses + task-routing
recommendations. Strong enough that automated routine replies become
defensible clinically and operationally.

---

## Where we are today (single-tenant trial)

- Big Easy Weight Loss is the only tenant.
- Staff manually paste each patient message; AI triages against a
  KB-driven prompt; staff edit and send the response themselves.
- All learning is passive (corrections logged, not yet fed back into
  the model).
- Webhook ingest stub exists but no background worker runs.

---

## Phases

### Phase 1 — Foundation (now → 2 weeks)
**Goal:** stop the bleeding from chat-model code drift. Make the system
maintainable before adding features.

- [x] AGENTS.md / PLAN.md committed
- [x] migrations/ folder with current schema captured
- [x] tenants table introduced (with Big Easy as row 1, fallbacks
  preserved for safety)
- [x] data/defaults.js — single source for hardcoded values
- [x] audit_log table created (write helper to follow)
- [x] Active KB learning wired: resolved review_requests with
  context=kb_gap or context=protocol auto-insert into kb_entries
- [x] Tests for pure functions (parseTriageJSON, urgencyScore,
  classifyMessage)
- [x] Idempotent ingest by external_id
- [x] Ingest status state machine documented (pending → triaged →
  reviewed → sent → patient_replied → closed)
- [x] Background worker stub (worker.js) — schedule TBD
- [x] Bask outbound stub (bask.js) — wire when API contract known
- [x] Edit-distance + time-to-edit captured as reward signal
- [ ] Sentry (or similar) wired for production errors
- [ ] esbuild bundling — deferred until app.js is split into modules

### Phase 2 — Active learning loop (next 1 month)
**Goal:** prove that staff feedback actually improves AI output.

- Auto-generate weekly per-tenant "house style" summary from corrections
  → injected into cached system prompt.
- Eval harness with 30–50 frozen historical cases. Re-run on every
  prompt/KB/model change. Track per-category accuracy.
- Confidence-weighted KB updates: high-confidence resolved Review
  Requests promote into KB; low-confidence stay as corrections.
- Closed-loop UX: when staff resolve a review, show "this edit changed
  X future triages" — concrete proof their feedback matters.
- Per-staff metrics page (already started in Triage Queue) extended
  with: agreement rate (% kept AI draft), edit time, severity overrides.

### Phase 3 — Channel framework + queue + soft routing (1–2 months from now)
**Goal:** patient messages flow in and out via any input channel
(not one specific partner), AND staff have a real per-person queue
instead of the single manual Run Triage flow.

#### Channels are the architectural concept, not partners

A **channel** is whatever pipe a patient message arrives through. The
system treats channels as pluggable adapters; the rest of Relai
(triage, KB, queue, learning loop, dashboards) is channel-agnostic.

A channel adapter is small. Two responsibilities:
1. **Inbound:** accept messages from a source (webhook handler, IMAP
   poller, polling job, websocket listener) and normalize them onto
   the standard `query_history` row shape with `source_channel` set
   to the channel id.
2. **Outbound:** post the staff-approved reply back into the same
   thread on the same channel.

Realistic channel landscape (priority by tenant demand, not build
order — most tenants will use 2–3 of these):

| Channel id        | Type / transport                         | Inbound             | Outbound       |
|-------------------|------------------------------------------|---------------------|----------------|
| `manual`          | Staff paste into the SPA (current)       | already live        | n/a            |
| `api`             | Generic webhook to `ingest.js`           | already live        | n/a            |
| `bask`            | Bask Health EHR (compounded meds)        | webhook             | API            |
| `email`           | Inbound email via Postmark / Mailgun     | webhook             | SMTP / API     |
| `healthie`        | Healthie EHR (general telehealth)        | webhook             | API            |
| `live_chat`       | Intercom / Drift / similar               | webhook             | API            |
| `sms`             | Twilio / Telnyx                          | webhook             | API            |
| `web_form`        | A practice's website contact form        | webhook             | n/a (or email) |
| `portal_direct`   | EHR-native patient portal messaging      | depends             | depends        |

This list grows. New channels land per-tenant demand without core
changes — same triage, same KB, same queue, same learning. The point
of the framework is that adding `healthie` looks structurally
identical to adding `bask`.

**Bask Health is one entry in this list.** Big Easy Weight Loss
happens to use Bask, so a Bask adapter is on the build list. If Bask
shuts down or Big Easy switches platforms, the migration is an
adapter swap — KB / triage / queue / learning data all keep working.
Tenants on a different EHR (or no EHR) get a different adapter
roster; nothing about the rest of Relai changes.

#### Build plan

**The framework (reusable across every adapter)**
- Move `netlify/functions/bask.js` (currently a stub) to
  `netlify/functions/channels/bask.js`. Establish the convention:
  every channel module under `channels/` exports `ingestHandler` and
  `sendOutbound`. New channel = new file in that directory.
- `worker.js` (the background processor) gains channel-aware
  outbound dispatch: when a triage transitions to `sent`, look up
  the channel module by `query_history.source_channel` and call its
  `sendOutbound`.
- Per-tenant channel config moves into the `tenants` table as a
  `channels jsonb` column: `{ "bask": { "api_url": "...", ... },
  "email": { "inbound_address": "...", ... } }`. Defaults in
  `data/defaults.js` for any channel without tenant-specific config.
- Shared dead-letter view: every adapter writes failures to one
  table (`channel_failures` or extend `audit_log`). Operations get
  one place to retry, regardless of channel.

**First two adapters** (chosen because they unblock Big Easy and are
likely-universal across future tenants):
- `bask`: outbound + inbound webhook handler. Build against the
  contract Bask Health publishes once they're engaged.
- `email`: inbound via Postmark Inbound (or equivalent) — forwards
  parsed emails to `ingest.js` with `channel: 'email'`. Outbound via
  whichever transactional-email provider the tenant uses (often the
  same one). Catches everything that doesn't have a dedicated EHR
  integration; useful for almost every tenant.

#### Per-staff queue (the thing we don't have yet today)

- Staff dashboard surfaces triaged-but-unresolved tasks **sorted by
  priority score** (severe SE → moderate → mild → clinical → non-
  clinical). Replaces today's manual Run Triage as the primary work
  surface, while keeping Run Triage available for ad-hoc messages.
- Each staff profile gains a `category_preferences` array (which
  categories they want in their queue) and a small set of capability
  flags (`can_send_clinical_responses`, etc.) that replace the old
  binary `Clinical / Non-Clinical` role over time. Migration: keep
  `role` populated for backwards compat; add capabilities; deprecate
  `role` once UI fully reads from capabilities.
- The queue filter for a given staff member = `category_preferences`
  ∩ `categories where requires_clinical_authorization is satisfied by
  the staffer's capabilities`. Defaults from `RELAI_DEFAULTS.categories`
  in data/defaults.js (already in place as of 2026-05-09).
- Channel-agnostic: queue items show their `source_channel` as a
  small badge/icon, but routing decisions don't depend on it. A
  Bask-sourced clinical question routes the same as an email-sourced
  one with the same category.

#### Reassignment as a learning signal

- One-click reassignment from a task: change category, optionally add
  a short note. Persisted as a new `task_reassignments` table (or as
  an action row in audit_log) capturing `triage_id`, `from_category`,
  `to_category`, `actor_id`, `created_at`, `note`.
- Used as: (a) the staff member's correction signal so the task moves
  to the right queue going forward, (b) high-quality training data for
  category accuracy — every reassignment is "AI was wrong, here's the
  right answer," already validated by a human.
- Surface the reassignment rate per category in the existing
  `/history/quality` endpoint as a new field (`reassignment_rate`)
  and per-prompt-version breakdown.

#### Knowledge Base scope expansion

- Once non-clinical channels (email, support inboxes, web forms) are
  live, the KB needs sections for non-clinical content: shipping
  policies, refund eligibility rules, the exact escalation paths to
  specific support inboxes, the canonical language for common
  operational replies. Add new section keys to `default-kb.js` and
  the `kb_entries.section` enum as needed; the AI already pulls from
  the full KB so no prompt change is required.
- The KB tab is already renamed to "Knowledge Base" (was "Clinical
  Knowledge Base") to reflect this — completed 2026-05-09.

### Phase 4 — Multi-tenant SaaS (3+ months from now)
**Goal:** a second paying customer running on the same code.

- Tenant onboarding wizard: name, KB template, first user invite.
- 2–3 starter KB templates (GLP-1 weight loss, primary care,
  dermatology). Stored as JSON or as seed migrations.
- Path-based tenant routing (`relai.app/<tenant-slug>/...`). Subdomain
  routing later.
- Per-tenant theme: logo, primary color, brand name. All driven from
  the `tenants` table via defaults.js.
- Stripe billing — likely seat-based ($X/staff/month) initially.
- Usage caps & cost dashboard per tenant (Anthropic spend by tenant).
- Audit log surfaces in-app for compliance reporting.
- HIPAA BAA when first paying customer requires it (plan for it; don't
  prematurely engineer).

### Phase 5 — Advanced learning (6+ months)
**Goal:** model quality improves materially without manual KB editing.

- Embedding-based KB chunk retrieval — only inject relevant KB sections
  per message rather than full KB. Cuts cost ~70% further.
- Per-tenant fine-tuning of a small model on correction history once
  >10k corrections exist for a tenant.
- Suggested KB updates via AI: "you've corrected the AI on similar
  messages 8 times this month — here's a draft KB entry to fix it,
  click approve."
- Auto-routing recommendations: "this looks like a Sarah message" based
  on historical handoff patterns.
- Staff workload balancing: dashboard recommends task assignment based
  on current queue + historical handle time.

---

## Non-goals (for now)

- Mobile-first redesign — staff use desktops/tablets in clinical settings
- React/Vue/Svelte rewrite — vanilla JS is fine until a real bottleneck
- Microservices — Netlify functions are right-sized
- Self-hosted infra — Supabase + Netlify until $100k+ ARR
- AI model training from scratch — prompt+KB beats fine-tuning until
  ~10k+ tenant-specific corrections exist
- Voice/transcription — text only

---

## Decisions log

| Date       | Decision | Rationale |
|------------|----------|-----------|
| 2026-05-08 | Triage on Sonnet 4.6, correction-analysis on Haiku 4.5 | Safety-critical classification needs Sonnet; diff summary is fine on Haiku |
| 2026-05-08 | Prompt caching via cache_control:ephemeral | KB rarely changes between triages, ~90% input cost cut |
| 2026-05-08 | Removed escalation Yes/No validation | Was unused; introduced false-zero stat |
| 2026-05-09 | tenants table with fallback to defaults.js | Must not break single-tenant flow; gradual migration |
| 2026-05-09 | Active KB learning enabled for kb_gap/protocol contexts | Closes the learning loop without manual KB edits |
| 2026-05-09 | Per-triage telemetry columns (model, prompt_version, kb_version, tokens, latency, cost, ai_confidence) | Foundation for measuring quality / cost trends and attributing regressions to specific prompt or KB versions |
| 2026-05-09 | KB tab renamed "Clinical Knowledge Base" → "Knowledge Base" | KB will hold non-clinical content (shipping, refunds, routing) once Bask integration lands; the old label was misleading |
| 2026-05-09 | `requires_clinical_authorization` per category in `RELAI_DEFAULTS.categories` | Decouple "what is this message about" (AI's job) from "who can resolve it" (compliance gate). Conservative defaults — vague categories like General Inquiry require clinical auth. AI does NOT read this flag; it's a routing/queue concern. Foundation for replacing the binary Clinical/Non-Clinical role with capability flags in Phase 3. |
| 2026-05-09 | Channels (not "Bask integration") are the architectural concept | Bask is one of many input sources (email, Healthie, live chat, SMS, web forms, EHR webhooks, manual paste). Each tenant picks their own roster. The framework treats every channel as a small adapter; the rest of Relai (triage, KB, queue, learning) is channel-agnostic. Big Easy uses Bask, but Bask going away tomorrow would just mean swapping adapters — no other system would need to change. Phase 3 retitled from "Bask integration" to "Channel framework + queue + soft routing" to reflect this. Bask gets the same treatment in PLAN, README, AGENTS, and adapter-file lead comments: example, not pillar. |
