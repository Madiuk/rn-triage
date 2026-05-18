-- 0033_query_history_hold_window_and_coalescing.sql
--
-- Implements the 5-minute hold + same-conversation coalescing workflow
-- for inbound patient messages. Together they replace today's "every
-- inbound message = one queue task" behavior with "every conversation
-- = one queue task, classifications still happen per message."
--
-- Behavior:
--   * A new inbound message on a conversation with NO open primary
--     task lands as a primary itself, with surface_at = NOW() + 5 min.
--     It does not appear in the queue until surface_at passes
--     (read-time filter — see netlify/functions/_lib/routes/queue.js).
--   * A new inbound message on a conversation that DOES have an open
--     primary lands as a follow-on: primary_task_id is set to the
--     existing primary's id. Follow-on rows are not pullable; they
--     exist so the chat-box renders the full thread and the worker
--     classifies each message independently for severity detection.
--   * The worker classifies every row (primary or follow-on). If a
--     row clears the severity threshold, the worker clears the
--     primary's surface_at so it surfaces immediately. If a follow-on
--     classifies more severe than its primary, the worker propagates
--     the higher severity (urgency_score, urgency_original,
--     clinical_routing_level) onto the primary — highest wins; a
--     later mild message never downgrades an earlier severe one.
--
-- Schema change:
--   * surface_at TIMESTAMPTZ NULL — when this primary task becomes
--     eligible for the queue. NULL = no hold (also the value after
--     the worker clears it on severity bypass, and the value on
--     existing rows after this migration runs). Set only on primary
--     rows; follow-on rows leave it NULL.
--   * primary_task_id UUID NULL — for follow-on rows, the id of the
--     primary task they coalesce into. NULL for primary rows
--     themselves. Self-FK with ON DELETE SET NULL so a deleted
--     primary doesn't cascade-kill its follow-ons (we don't DELETE
--     clinical rows today; the constraint is defensive).
--   * Partial index on (company_id, conversation_id) WHERE the row
--     is an open primary — supports the insert-time lookup
--     "is there an open primary for this conversation?"
--   * Partial index on surface_at WHERE NOT NULL — supports the
--     read-time filter for held tasks.
--   * Partial index on primary_task_id WHERE NOT NULL — supports
--     follow-on lookups during severity propagation. Mirrors the
--     parent_task_id index from migration 0026.
--
-- BEHAVIORAL IMPACT on existing rows:
--   * surface_at and primary_task_id default to NULL. Every existing
--     row becomes an unheld primary, which matches its current
--     behavior — no in-flight task changes its queue eligibility.
--
-- Note: primary_task_id is NOT the same column as parent_task_id
-- (migration 0026). parent_task_id is for the cross-category
-- follow-up workflow (staff spawns a child task for billing while
-- replying to a clinical one). primary_task_id is for coalescing
-- multiple inbound messages on one conversation into one queue task.
-- The two columns coexist and are independent.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists surface_at timestamptz;

alter table public.query_history
  add column if not exists primary_task_id uuid;

-- Self-FK. Drop+recreate is idempotent-safe via DO block.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_primary_task_id_fkey;
exception when others then null;
end$$;

alter table public.query_history
  add constraint query_history_primary_task_id_fkey
  foreign key (primary_task_id)
  references public.query_history(id)
  on delete set null;

-- Insert-time lookup: "any open primary for (company_id,
-- conversation_id)?" The status set is materialized rather than
-- joined against a values table; if the OPEN_STATUSES list in
-- netlify/functions/_lib/routes/queue.js changes, this partial
-- index needs the same change. Today the list is
-- ('pending','triaged','reviewed','patient_replied').
create index if not exists query_history_open_primary_idx
  on public.query_history (company_id, conversation_id)
  where conversation_id is not null
    and primary_task_id is null
    and status in ('pending', 'triaged', 'reviewed', 'patient_replied');

-- Read-time filter: "primary tasks held in the surface window."
-- Partial because most rows are NULL.
create index if not exists query_history_surface_at_idx
  on public.query_history (surface_at)
  where surface_at is not null;

-- Follow-on lookup for severity propagation. Mirrors the
-- parent_task_id index from migration 0026.
create index if not exists query_history_primary_task_id_idx
  on public.query_history (primary_task_id)
  where primary_task_id is not null;
