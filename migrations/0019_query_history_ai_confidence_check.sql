-- 0019_query_history_ai_confidence_check.sql
--
-- Defense-in-depth for finding 2 of RELAI_DB_INTEGRITY_AUDIT.md.
-- Adds a range CHECK to query_history.ai_confidence — a column the
-- earlier enum-CHECK work in 0012-0014 / 0018 did not cover because
-- the value is a numeric, not an enum.
--
-- COLUMN: ai_confidence numeric(3,2)
--   (declared in migrations/0005_triage_observability.sql)
--   Type alone restricts to values like -9.99 through 9.99 — but the
--   AI's contract is [0, 1]. validateTriageOutput in data/triage-lib.js
--   rejects out-of-range values at the proxy layer; this CHECK is the
--   DB-layer mirror so a future code path that bypasses the proxy
--   cannot persist a corrupt confidence.
--
-- ALLOWED VALUES: NULL or 0 <= ai_confidence <= 1
--
-- Canonical source: validateTriageOutput in data/triage-lib.js, which
-- rejects `parsed.ai_confidence < 0 || parsed.ai_confidence > 1`.
-- The companion test asserts this constraint stays in agreement with
-- that validator.
--
-- BEHAVIORAL IMPACT:
--   * Valid rows (NULL or 0..1 inclusive): no effect.
--   * Dirty rows (out-of-range numeric values from before the proxy
--     enforced strict validation): backfilled to NULL. Downstream
--     consumers handle NULL ai_confidence gracefully — confidence-rate
--     metrics and the partial index on ai_confidence are both
--     `where ai_confidence is not null`, so a NULL drops the row
--     from the metric rather than skewing it.
--
-- Idempotent — safe to re-run.

-- 1. Backfill: clear any pre-existing out-of-range values to NULL.
--    Numeric NULL is the documented "no confidence recorded" signal
--    (see 0005 partial index `where ai_confidence is not null`).
update public.query_history
set ai_confidence = null
where ai_confidence is not null
  and (ai_confidence < 0 or ai_confidence > 1);

-- 2. Drop any prior version of this constraint.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_ai_confidence_check;
exception when others then null;
end$$;

-- 3. Add the CHECK. The IS NULL OR pattern is written explicitly so
--    the intent is visible in pg_constraint and in code review,
--    matching the convention used in 0012-0014 / 0018.
alter table public.query_history
  add constraint query_history_ai_confidence_check
  check (
    ai_confidence is null
    or (ai_confidence >= 0 and ai_confidence <= 1)
  );
