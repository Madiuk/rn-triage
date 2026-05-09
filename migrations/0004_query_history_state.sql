-- 0004_query_history_state.sql
-- Formalize the status state machine on query_history and add
-- edit_distance. Idempotent — safe to re-run.

-- Add edit_distance column (already declared in 0001_baseline if you
-- ran that fresh; this guards older deployments).
alter table public.query_history
  add column if not exists edit_distance integer;

-- Ensure status has a sensible default and is indexed for the worker
-- to find pending rows quickly.
alter table public.query_history
  alter column status set default 'completed';

-- Drop and recreate the status check constraint (idempotent via
-- conditional). Status values:
--   pending          - ingested, not yet triaged
--   triaged          - AI ran, awaiting staff review
--   reviewed         - staff approved or edited the draft
--   sent             - response posted back to EHR
--   patient_replied  - patient sent a follow-up
--   closed           - thread closed, no further action
--   completed        - manual triage finished (legacy default)
do $$
begin
  alter table public.query_history drop constraint if exists query_history_status_check;
exception when others then null;
end$$;

alter table public.query_history
  add constraint query_history_status_check
  check (status in (
    'pending', 'triaged', 'reviewed', 'sent',
    'patient_replied', 'closed', 'completed'
  ));

-- Helper index for the background worker
create index if not exists query_history_pending_idx
  on public.query_history (created_at)
  where status = 'pending';
