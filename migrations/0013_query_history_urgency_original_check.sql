-- 0013_query_history_urgency_original_check.sql
--
-- Defense-in-depth for finding 2 of RELAI_DB_INTEGRITY_AUDIT.md,
-- continuing the work in 0012. This migration adds the CHECK on the
-- urgency_original column.
--
-- ALLOWLIST DIFFERS FROM 0012:
--   urgency_override (0012) = routine | 24h | 24-72h | same-day | urgent
--   urgency_original (here) = routine | same-day | urgent
--
-- Why the asymmetry: urgency_original is what the AI emits; the AI's
-- enum is the 3-value coarse bucket (see normalizeTriageOutput in
-- data/triage-lib.js). urgency_override is what staff pick from the
-- timeframe dropdown, which exposes two extra finer-grained values
-- (24h, 24-72h) staff can use to refine the AI's coarse routine
-- bucket. The DB CHECKs encode this asymmetry directly — staff can
-- refine the AI's value, but the AI cannot emit a value the
-- refinement enum would reject.
--
-- BEHAVIORAL IMPACT:
--   * Valid rows (NULL or one of the three allowlisted values): no
--     effect.
--   * Dirty rows (uppercase, legacy AI emissions before normalization
--     was added, manual SQL writes): the backfill UPDATE clears the
--     value to NULL before the CHECK lands.
--   * Downstream readers handle NULL urgency_original gracefully —
--     the history table UI does `r.urgency_override || r.urgency_original
--     || '-'` so a NULL gets the em-dash. The aggregation logic in
--     history-aggregations.js uses `row.urgency_override !==
--     row.urgency_original` to detect overrides; with the original
--     NULLed, a non-NULL override would always count as an override
--     for those rows. Acceptable — same direction as 0012's effect.
--
-- CONTRACT: the allowlist below must stay set-equal to the array
-- literal in normalizeTriageOutput's `out.urgency = normalizeEnum(...)`
-- call. The companion test enforces parity so neither side can drift.
--
-- Idempotent — safe to re-run.

-- 1. Backfill: clear any pre-existing non-conforming values to NULL.
update public.query_history
set urgency_original = null
where urgency_original is not null
  and urgency_original not in ('routine', 'same-day', 'urgent');

-- 2. Drop any prior version of this constraint.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_urgency_original_check;
exception when others then null;
end$$;

-- 3. Add the CHECK.
alter table public.query_history
  add constraint query_history_urgency_original_check
  check (
    urgency_original is null
    or urgency_original in ('routine', 'same-day', 'urgent')
  );
