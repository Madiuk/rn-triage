-- 0005_triage_observability.sql
-- Per-triage telemetry: model used, prompt/KB version stamps, token
-- usage, latency, cost, and AI self-reported confidence. The point is
-- to make every triage a labeled data point so we can:
--
--   * Measure accuracy/latency/cost trends over time, scoped to tenant.
--   * Attribute regressions to a specific prompt or KB version when
--     they ship, instead of guessing.
--   * Compute cache-hit rate and per-tenant spend without re-querying
--     Anthropic.
--   * Feed the eval harness with realistic ground-truth-vs-AI deltas.
--
-- All columns nullable to keep older rows valid. Idempotent — safe to
-- re-run.

alter table public.query_history
  add column if not exists model                  text,
  add column if not exists prompt_version         text,
  add column if not exists kb_version             text,
  add column if not exists input_tokens           integer,
  add column if not exists output_tokens          integer,
  add column if not exists cache_creation_tokens  integer,
  add column if not exists cache_read_tokens      integer,
  add column if not exists latency_ms             integer,
  add column if not exists ai_confidence          numeric(3,2),
  add column if not exists cost_usd               numeric(10,6),
  add column if not exists error_class            text;

-- Time-series queries (cost-per-day, latency-p95-per-day) are by far
-- the most common read pattern on these columns. Combined with
-- company_id for tenant scoping.
create index if not exists query_history_company_created_idx2
  on public.query_history (company_id, created_at desc);

-- Find every triage produced by a given prompt/KB version. Useful when
-- a regression appears and you need to retire that version.
create index if not exists query_history_versions_idx
  on public.query_history (prompt_version, kb_version)
  where prompt_version is not null;

-- ai_confidence is captured for every triage (not just review_requests)
-- so we can plot calibration: does the AI's self-rated confidence
-- correlate with whether staff overrode the urgency or rewrote the
-- draft? If not, the threshold needs tuning.
create index if not exists query_history_confidence_idx
  on public.query_history (ai_confidence)
  where ai_confidence is not null;
