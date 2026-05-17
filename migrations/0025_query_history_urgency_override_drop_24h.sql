-- 0025_query_history_urgency_override_drop_24h.sql
--
-- Narrows the urgency_override allowlist from five values to three.
--
-- Why: the legacy "24h" and "24-72h" finer-grained refinements of
-- "routine" were never wired into the new tasking SPA UI. Going
-- forward, urgency_override mirrors urgency_original's three-value
-- set exactly — routine | same-day | urgent — so staff edits read
-- back as a direct over-ride of the AI's value rather than a
-- different finer-grained scale.
--
-- ALLOWLIST CHANGE:
--   Before (migration 0012): routine | 24h | 24-72h | same-day | urgent
--   After (this migration):  routine | same-day | urgent
--
-- BEHAVIORAL IMPACT:
--   * Rows whose urgency_override is currently '24h' or '24-72h':
--     backfill UPDATE below clears those to NULL before the new
--     CHECK lands. Lossy on those two values only; the row itself
--     and every other column is preserved. Aggregations in
--     history-aggregations.js that count overrides will lose those
--     specific rows from the "overrode" tally — acceptable, since
--     those values cannot be re-entered.
--   * Rows already in {routine, same-day, urgent} or NULL: unaffected.
--   * The route module URGENCY_OVERRIDE_VALUES in
--     netlify/functions/_lib/routes/history.js has been narrowed
--     to match. The companion parity test
--     tests/queryHistoryUrgencyOverrideCheck.test.js now reads from
--     this migration (0025) rather than 0012.
--
-- PATTERN: mirrors 0012's structure — backfill non-conforming values
-- to NULL, drop the prior CHECK if present, add the new one. Each
-- step is idempotent.
--
-- CONTRACT: the allowlist below must stay set-equal to
-- URGENCY_OVERRIDE_VALUES in
-- netlify/functions/_lib/routes/history.js. The parity test enforces
-- this so neither side can drift without a visible CI failure.

-- 1. Backfill: clear any '24h' or '24-72h' rows to NULL. The new
--    CHECK would reject them otherwise.
update public.query_history
set urgency_override = null
where urgency_override in ('24h', '24-72h');

-- 2. Drop the prior version of the constraint so the ADD below is a
--    no-op on re-run and idempotent on a fresh schema that ran 0012.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_urgency_override_check;
exception when others then null;
end$$;

-- 3. Add the narrower CHECK. NULL still allowed (no override applied).
alter table public.query_history
  add constraint query_history_urgency_override_check
  check (
    urgency_override is null
    or urgency_override in ('routine', 'same-day', 'urgent')
  );
