-- 0012_query_history_urgency_override_check.sql
--
-- Targeted defense-in-depth for finding 2 of RELAI_DB_INTEGRITY_AUDIT.md:
-- query_history's enum-shaped columns have no CHECK constraints, so the
-- only thing standing between "garbage urgency value" and the row is
-- whatever validation the calling route happens to apply. Today the
-- staff-edit path validates via URGENCY_OVERRIDE_VALUES in
-- netlify/functions/_lib/routes/history.js, but the default-branch
-- insert at the bottom of that file accepts whatever the client sends.
--
-- This migration narrows the fix to one column: urgency_override — the
-- staff-edit field. urgency_original, clinical_routing_level,
-- clinical_category, and source_channel are out of scope (same finding,
-- separate columns).
--
-- BEHAVIORAL IMPACT:
--   * Valid data (NULL, or any of the five allowlisted values): unaffected.
--   * Dirty data (uppercase, legacy values, manual SQL writes): the
--     backfill UPDATE below clears those to NULL before the CHECK lands.
--     Downstream readers:
--       - history-aggregations.js urgency_override_rate metric will
--         shift downward by exactly the count of cleared rows.
--       - The history-table UI falls back to urgency_original via
--         `r.urgency_override || r.urgency_original || '-'`, so users
--         see the AI's urgency instead of garbage. Net improvement.
--       - The Haiku correction analyzer reads timeframe from the live
--         DOM <select>, not from the DB column, so the AI learning
--         loop is completely unaffected by this backfill.
--
-- PATTERN: mirrors 0004_query_history_state.sql's treatment of the
-- status column — backfill non-conforming values to a safe default,
-- then add the CHECK. Idempotent — safe to re-run.
--
-- CONTRACT: the allowlist below must stay set-equal to
-- URGENCY_OVERRIDE_VALUES in
-- netlify/functions/_lib/routes/history.js. The companion test
-- tests/queryHistoryUrgencyOverrideCheck.test.js enforces this parity
-- so neither side can drift without a visible test failure.

-- 1. Backfill: clear any pre-existing non-conforming values to NULL.
--    Lossy for the bad value only — the row itself is preserved.
update public.query_history
set urgency_override = null
where urgency_override is not null
  and urgency_override not in ('routine', '24h', '24-72h', 'same-day', 'urgent');

-- 2. Drop any prior version of this constraint so re-runs are no-ops.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_urgency_override_check;
exception when others then null;
end$$;

-- 3. Add the CHECK. Allows NULL (no override applied) OR one of the
--    five allowlisted values. NULL passes any CHECK in PostgreSQL by
--    default (CHECK only rejects FALSE), but the `IS NULL OR` is
--    written explicitly so the intent is visible in pg_constraint and
--    in code review.
alter table public.query_history
  add constraint query_history_urgency_override_check
  check (
    urgency_override is null
    or urgency_override in ('routine', '24h', '24-72h', 'same-day', 'urgent')
  );
