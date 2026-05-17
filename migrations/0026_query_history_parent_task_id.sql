-- 0026_query_history_parent_task_id.sql
--
-- Adds the parent_task_id column to query_history. This enables the
-- "follow-up task" workflow added in the tasking SPA: a staff
-- member working an inbound message can spawn child tasks bound for
-- other categories (e.g., a clinical reply that also needs a
-- billing handoff). The children stay in `status='pending_parent'`
-- until the parent terminates via /queue/send or
-- /queue/close-no-reply, at which point they flip to
-- `status='triaged'` and enter the queue of their target category.
--
-- Schema change:
--   * Add column `parent_task_id uuid` (nullable; null for inbound
--     and other non-followup rows).
--   * Self-referencing FK with ON DELETE SET NULL. If a parent row
--     is ever hard-deleted, surviving children become orphans rather
--     than getting cascaded into oblivion. /queue/retask deletes
--     pending_parent children explicitly; this FK behavior is the
--     defensive fallback for any other code path.
--   * Index on parent_task_id for the child-lookup query that
--     /queue/send and /queue/close-no-reply run.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists parent_task_id uuid;

-- Self-FK. Drop+recreate is idempotent-safe via DO block.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_parent_task_id_fkey;
exception when others then null;
end$$;

alter table public.query_history
  add constraint query_history_parent_task_id_fkey
  foreign key (parent_task_id)
  references public.query_history(id)
  on delete set null;

-- Lookup index. Children-of-parent is the only access pattern.
create index if not exists query_history_parent_task_id_idx
  on public.query_history (parent_task_id)
  where parent_task_id is not null;
