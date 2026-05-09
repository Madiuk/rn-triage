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

### Phase 3 — Bask integration (1–2 months from now, gated on Bask API)
**Goal:** patient messages flow in and out without copy-paste.

- ingest.js receives Bask webhook → `query_history` row with
  `status: pending`, `source_channel: 'bask'`.
- worker.js polls pending rows on a schedule (Supabase Edge Function
  via pg_cron, or Inngest), runs triage, transitions to `triaged`.
- Staff dashboard shows triaged-but-unreviewed queue. Approve/edit/send
  → bask.js POSTs response back to Bask API → status `sent`.
- Patient reply webhook → new pending row linked to the prior thread
  via `external_id` or `thread_id`. Prior context auto-included.
- Failure handling: bask down, AI down, malformed input — each goes to
  a dead-letter view with retry button.

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
