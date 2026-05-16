-- 0022_query_history_queue_state.sql
--
-- Phase 3 substrate — pull-queue mechanics on query_history.
-- (See ROADMAP.md "Week 1 — Substrate" and PLAN.md "Per-staff queue",
-- "Service-level windows and the Due state", and "Task ownership,
-- assignment, and handoffs".)
--
-- Adds:
--   1. claimed_by, claimed_at — current task ownership (null = in pool)
--   2. first_pulled_at — immutable anchor for the 24h initial SLA
--   3. last_patient_reply_at — anchor for the 8h reply SLA (cleared
--      on staff send or on 8h sweep fire)
--   4. due_state — sticky boolean, set when any SLA expires; only
--      ever transitions false → true; survives re-pulls and re-tasks
--   5. Indexes to keep "my queue" and SLA sweep queries cheap
--   6. task_reassignments table — audit trail for category
--      reassignments (feeds "Reassignment as a learning signal" in
--      PLAN.md)
--
-- SAFETY:
--   - All ALTER TABLE adds are nullable, EXCEPT due_state which is
--     NOT NULL DEFAULT false. In Postgres 11+ this is an instant
--     catalog-only operation (no table rewrite, no row locks).
--   - No drops, no renames, no NOT NULL adds on existing columns,
--     no behavior changes for existing code.
--   - The current system (app.js + index.html + every existing
--     endpoint) does not read or write any of these columns. The
--     new queue endpoints (Week 1, ROADMAP.md §1.2) will be the
--     first consumers.
--   - task_reassignments follows the existing tenant-scoped pattern:
--     company_id FK, RLS enabled with explicit deny for authenticated
--     / anon. Service-role (SUPABASE_SERVICE_KEY) bypasses RLS so all
--     Netlify-function paths work normally.
--   - Idempotent — `add column if not exists`, `create table if not
--     exists`, drop-then-create policy. Safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Queue state columns on query_history
-- ─────────────────────────────────────────────────────────────────────

alter table public.query_history
  add column if not exists claimed_by uuid;
alter table public.query_history
  add column if not exists claimed_at timestamptz;
alter table public.query_history
  add column if not exists first_pulled_at timestamptz;
alter table public.query_history
  add column if not exists last_patient_reply_at timestamptz;
alter table public.query_history
  add column if not exists due_state boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Indexes for the queue and SLA sweep paths
-- ─────────────────────────────────────────────────────────────────────

-- "My queue" lookup: staff fetches their current claimed tasks.
-- Partial index — only claimed rows pay the storage cost.
create index if not exists query_history_claimed_by_idx
  on public.query_history (company_id, claimed_by)
  where claimed_by is not null;

-- 24h SLA sweep: tasks past 24h since first pull, not yet flagged Due.
-- Once due_state flips true, the row exits this partial index — no
-- repeat firing for the same task on the same SLA reason.
create index if not exists query_history_first_pulled_idx
  on public.query_history (first_pulled_at)
  where claimed_by is not null and due_state = false;

-- 8h SLA sweep: tasks with an unanswered patient reply older than 8h.
-- Worker clears last_patient_reply_at when the sweep fires (or when
-- staff sends a response), so the row exits this index.
create index if not exists query_history_patient_reply_idx
  on public.query_history (last_patient_reply_at)
  where last_patient_reply_at is not null and claimed_by is not null;

-- ─────────────────────────────────────────────────────────────────────
-- 3. task_reassignments — audit trail for category reassignments
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.task_reassignments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.companies(id) on delete cascade not null,
  triage_id     uuid references public.query_history(id) on delete cascade not null,
  from_category text,
  to_category   text not null,
  actor_id      uuid,
  actor_name    text,
  note          text,
  created_at    timestamptz default now()
);

create index if not exists task_reassignments_triage_idx
  on public.task_reassignments (company_id, triage_id);
create index if not exists task_reassignments_recent_idx
  on public.task_reassignments (company_id, created_at desc);

-- RLS: enable + explicit deny for authenticated/anon. Service-role
-- (Netlify functions via SUPABASE_SERVICE_KEY) bypasses RLS, so all
-- application reads/writes continue to work normally.
alter table public.task_reassignments enable row level security;

do $$
begin
  begin
    drop policy if exists task_reassignments_user_deny on public.task_reassignments;
  exception when others then null;
  end;

  create policy task_reassignments_user_deny
    on public.task_reassignments
    for all
    to authenticated, anon
    using (false)
    with check (false);
end $$;
