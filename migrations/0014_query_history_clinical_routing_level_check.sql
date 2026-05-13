-- 0014_query_history_clinical_routing_level_check.sql
--
-- Defense-in-depth for finding 2 of RELAI_DB_INTEGRITY_AUDIT.md,
-- continuing the work in 0012 and 0013. Adds the CHECK on
-- query_history.clinical_routing_level.
--
-- The column has DEFAULT 'none' from 0001_baseline, so the practical
-- expectation is that every existing row carries one of the four
-- allowlisted values or NULL. The defensive backfill is here for
-- safety regardless.
--
-- ALLOWLIST: severe | moderate | mild | none
--
-- Canonical source: normalizeTriageOutput in data/triage-lib.js. The
-- companion test asserts set-equality with that source.
--
-- BEHAVIORAL IMPACT:
--   * Valid rows: no effect.
--   * Dirty rows (uppercase, legacy values from before
--     normalizeTriageOutput existed): backfilled to NULL. Downstream
--     readers:
--       - buildSeverityBadge in app.js falls through to no badge for
--         unknown values, so a NULL renders the same as 'none' for
--         UI purposes.
--       - rowIsClinical in permissions.js uses
--         `level === 'severe' || level === 'moderate' || level === 'mild'`
--         — a NULL falls through to the non-routing branch, which
--         then keys off clinical_category. Same net behavior as 'none'.
--       - history-aggregations.js escalations counter uses
--         `row.clinical_routing_level && row.clinical_routing_level !== 'none'`
--         — NULL is falsy, so a backfilled row doesn't count as
--         escalated. This matches what 'none' would do; net zero
--         shift.
--
-- Idempotent — safe to re-run.

-- 1. Backfill: clear any pre-existing non-conforming values to NULL.
update public.query_history
set clinical_routing_level = null
where clinical_routing_level is not null
  and clinical_routing_level not in ('severe', 'moderate', 'mild', 'none');

-- 2. Drop any prior version of this constraint.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_clinical_routing_level_check;
exception when others then null;
end$$;

-- 3. Add the CHECK.
alter table public.query_history
  add constraint query_history_clinical_routing_level_check
  check (
    clinical_routing_level is null
    or clinical_routing_level in ('severe', 'moderate', 'mild', 'none')
  );
