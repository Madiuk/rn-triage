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

#### Task ownership and handoffs

A patient message creates one task. One task has one **primary owner**
at a time. This section answers the questions that are moot today
(single staff, manual paste) but become load-bearing the moment two
or more staff have a shared queue:

- *Who owns a task with both clinical and non-clinical parts?*
- *Who sends the final reply to the patient?*
- *What stops two staff from working on the same task in parallel
  and sending two conflicting replies?*
- *How does work get handed off to another team without losing it?*
- *What happens when the AI is unsure?*

The model:

1. **AI picks a primary category.** Each message gets one or more
   categories from the tenant's list. The primary category is the
   one with the highest-gated `required_capabilities` (for medical
   tenants today: a category requiring `clinical_response` outranks
   one that doesn't). Tie-broken by `urgency_score`.
2. **Task lands in the primary category's queue.** Anyone whose
   capability set satisfies that category's requirements AND who has
   that category in their `category_preferences` sees the task as
   claimable. Other staff see nothing.
3. **Claiming creates ownership.** When a staff member starts work,
   they claim the task: `query_history.claimed_by` = their user_id,
   `claimed_at` = now. Other staff in the same queue see it as
   "claimed by Jane" — visible for transparency, not actionable.
   This is the core **redundancy control** — only one owner at a
   time, no parallel conflicting replies.
4. **The owner sends the final reply to the patient.** Period. There
   is exactly one outbound to the patient per task, and it comes
   from the owner. Even when a task has a clinical part AND a
   non-clinical part, only the owner replies; the other team's work
   happens internally, not in the patient-facing thread.
5. **Internal handoffs are structured, not free-text pastes.** When
   the owner needs another team to do something (ship a replacement,
   process a refund, transfer a pharmacy, schedule a fitting),
   they create an **internal action** linked to the task. The
   action appears in the relevant team's queue with a
   "linked to triage #N" reference. The support team marks the
   action complete; the owner sees that and proceeds with the
   patient reply.

   This replaces the current "Internal Note for Staff free-text
   paste" pattern. The internal note becomes the *content* of a
   structured action, which is queryable, trackable, and learnable
   from. New table: `task_actions` (or extend `audit_log`) with
   `triage_id`, `action_type`, `assigned_to_capability`,
   `description`, `status`, `completed_by`, `completed_at`.
6. **Reassignment for misclassification.** If the owner sees the AI
   put the task in the wrong queue (e.g., labeled "Side Effects"
   but really "Refund Request"), one click reassigns. The task
   moves to the new category's queue, the owner releases ownership,
   the new queue's staff can claim. Reassignment also feeds the
   learning loop (see *Reassignment as a learning signal* below).
7. **Release back to queue.** An owner who can't complete a task
   releases it: `claimed_by` returns to NULL. Another staff member
   in the same queue can claim. UI: a "Release" button next to the
   "Submit & Send" button.
8. **Ambiguous / low-confidence cases route conservatively.** When
   `ai_confidence` is below the review threshold, or when the AI
   produces a category but flags `review_request`, the task routes
   to the **highest-capability-required queue** — the gating role.
   For medical tenants that's the clinical queue; for a tire shop
   it might be the certified-mechanic queue. Better to over-
   escalate than under-escalate.
9. **No accidental merging.** Each inbound message creates exactly
   one task. Bask retries / duplicate webhooks dedupe by
   `external_id` (already implemented in `ingest.js`). Manual
   pastes can theoretically duplicate; admins can merge or delete
   via the audit_log workflow.

The pattern is vertical-agnostic. For a tire repair shop, substitute
"certified mechanic" for "clinical" and "service writer" for
"non-clinical." For property management, substitute "licensed
property manager" for "clinical" and "leasing agent" for
"non-clinical." The semantics — gating role, primary owner, claim-
to-lock, structured handoffs, reassignment, conservative routing on
ambiguity — don't change. That's what makes the framework portable.

DB additions this section implies (deferred until queue work
begins, but listed here so they aren't surprises):
- `query_history.claimed_by uuid references auth.users(id)` and
  `claimed_at timestamptz` (nullable; null = unclaimed).
- `task_actions` table for internal handoffs.
- `task_reassignments` table (or an `audit_log` action type).

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

### Phase 4 — Multi-tenant SaaS, vertical-agnostic (3+ months from now)
**Goal:** a second paying customer in **any vertical** running on the
same code — not just another medical practice.

#### Vertical-agnostic readiness audit (today's state)

Relai's data model and infrastructure are mostly portable. A few
pieces are shaped around clinical telehealth because Big Easy is the
only tenant. They need to become per-tenant config before tenant #2
lands — especially if tenant #2 isn't medical (e.g., a tire repair
shop's customer-service inbox, a property-management leasing inbox, a
veterinary clinic, professional services).

| What's Big-Easy-shaped today                                    | Status         | What it needs to become |
|-----------------------------------------------------------------|----------------|--------------------------|
| `CLINICAL_CATS` / `NON_CLINICAL_CATS` hardcoded in `app.js`     | medical-only   | Per-tenant category list, sourced from `tenants.category_metadata` (or equivalent) with `RELAI_DEFAULTS.categories` as fallback for the bootstrap tenant. |
| `BASE_PROMPT` (clinical telehealth voice + JSON shape)          | medical-only   | Either (a) a vertical-agnostic core prompt with tenant-injected voice/role context, or (b) per-tenant prompt templates seeded from a small library. The JSON output shape can stay generic. |
| `requires_clinical_authorization` flag in `RELAI_DEFAULTS.categories` | medical-named, structurally generic | Generalize to `required_capabilities: string[]`. A category can require any named capability (`'clinical_response'`, `'certified_mechanic'`, `'licensed_property_manager'`, `'billing_access'`, etc.). Staff capability flags become arbitrary tenant-defined strings, gated against this list. The current shape is the simplest case (`'clinical_response'` either required or not); the rename is mechanical. |
| `clinical_category` and `clinical_routing_level` columns on `query_history` | medical-named, structurally generic | Either rename to neutral (`primary_category`, `routing_severity`) or accept they're nullable for non-medical tenants. The data they hold is already free text; only the column names lean medical. |
| KB section keys (`sideeffects`, `protocols`, `notes`)           | medical-flavored | Tenants supply their own section list. Defaults provide a generic set ("Decision Rules", "Templates", "Reference", "URLs") plus a vertical-specific seed pack on onboarding. |
| Default KB content in `data/default-kb.js`                      | GLP-1-specific | Stays as Big Easy's seed. New tenants pick a different seed pack at onboarding (or start blank). |
| HIPAA BAA assumption                                            | medical-only   | Treat as one of N compliance regimes. Some verticals need none (auto repair); some need different ones (veterinary may have state-specific data rules; property management may need fair-housing audit trails). The BAA wiring stays a Big-Easy / medical-tenant feature. |
| `eval/cases/*.json` (medical scenarios)                         | medical-only   | Per-tenant eval set. Each tenant maintains their own. The harness itself is generic. |

**Already vertical-agnostic** (will not need work for tenant #2):
- DB schema: `kb_entries`, `companies`, `company_members`, `tenants`,
  `audit_log`, `query_history` (data model — column names aside).
- Auth, profile, magic-link login.
- Channel framework (Phase 3).
- Telemetry / cost / quality endpoints.
- Eval harness mechanics.
- Triage / KB / queue / learning loop architecture.

#### Tenant onboarding (vertical-agnostic)
- Onboarding wizard: name, **vertical** (medical / professional
  services / retail / property / veterinary / other), KB seed pack
  (from a small library of starters + "blank"), first user invite.
- Starter KB seed packs at launch: GLP-1 weight loss (proven via Big
  Easy), primary care, one **non-medical** seed (e.g., automotive
  service or property management) to *prove* the framework actually
  works without medical assumptions baked in.
- Path-based tenant routing (`relai.app/<tenant-slug>/...`).
  Subdomain routing later.
- Per-tenant theme: logo, primary color, brand name, voice register.
- Stripe billing — seat-based.
- Usage caps & cost dashboard per tenant (Anthropic spend by tenant).
- Audit log surfaces in-app for compliance reporting.
- HIPAA BAA only when a tenant's vertical requires it. Don't presume
  every tenant is medical.

#### When tenant #2 is in sight (the unblock checklist)
This list runs before any second tenant is provisioned, regardless
of their vertical. It exists so we don't discover the medical
assumptions at onboarding time:

1. Move category list from `app.js` constants to per-tenant config.
   Big Easy's existing categories become the tenant's row; UI reads
   from there.
2. Rename `requires_clinical_authorization` → `required_capabilities:
   string[]`. Big Easy's clinical categories migrate to
   `['clinical_response']`. Mechanical change; tests already cover the
   helper's behavior so the rename is safe.
3. Decide on `clinical_category` / `clinical_routing_level` — rename
   to neutral terms or document them as "free-text, optional, used by
   medical tenants." Either is fine; pick one and move on.
4. Audit `BASE_PROMPT` and produce a vertical-neutral version (or a
   parametrizable template). Keep Big Easy's prompt as the seed.
5. Add `tenant.category_metadata` and `tenant.kb_seed_pack` columns
   if not already present. The `tenants` table is already in place.

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
| 2026-05-09 | Phase 4 is vertical-agnostic, not "more medical tenants" | The architecture supports any kind of customer-service triage (medical, automotive, property, professional services, retail). A few pieces lean medical because Big Easy is the only tenant — those are catalogued in PLAN's "Vertical-agnostic readiness audit" with a concrete unblock checklist that runs before tenant #2 lands regardless of their vertical. Don't bake more medical assumptions into core code while we have one tenant; keep them at the tenant-config layer. |
| 2026-05-09 | One task, one primary owner, structured handoffs (the ownership model for Phase 3) | Avoids the questions "who owns?", "who replies?", "what stops two staff working in parallel?" that the queue UI would otherwise have to invent ad-hoc. Single owner via `claimed_by` lock; owner sends the one patient reply; cross-team work happens via structured `task_actions` not free-text pastes; reassignment for misclassification; release-back-to-queue if the owner can't finish; ambiguous cases route conservatively to the gating role. Pattern is vertical-agnostic — substitute "certified mechanic" or "licensed property manager" for "clinical" and the semantics hold. Today's manual-paste flow doesn't exercise any of this; the model only matters once Phase 3 ingest + queue land. Codified in PLAN Phase 3 "Task ownership and handoffs" before the implementation begins. |
| 2026-05-09 | Tagged **v0.3.0** as the foundation-phase waypoint | Closes Phase 1 and the foundation work. Single-tenant trial is fully instrumented: per-triage telemetry, real eval harness, cost & quality endpoints, ownership model documented, channel framework designed, vertical-agnostic positioning explicit. CHANGELOG.md added. Future releases get one CHANGELOG entry plus a git tag. v0.4.0 lands when Phase 3 (channel framework + queue + soft routing) ships. |
