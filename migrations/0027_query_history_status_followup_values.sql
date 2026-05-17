-- 0027_query_history_status_followup_values.sql
--
-- Extends query_history.status CHECK to allow two new values added
-- by the tasking SPA's follow-up workflow:
--
--   * pending_parent  - a follow-up task spawned by the originator
--                       of an inbound message. Sits idle (out of all
--                       queues) until the parent terminates via Send
--                       or Close-no-reply, at which point /queue
--                       flips it to 'triaged' so it enters the
--                       target category's pool.
--   * closed_no_reply - terminal status for tasks closed without a
--                       patient-facing reply. Distinct from 'sent'
--                       (which implies a patient reply went out) and
--                       'closed' (legacy; reserved for thread-close
--                       lifecycle from the patient side per 0004).
--
-- ALLOWLIST CHANGE:
--   Before (migration 0004): pending | triaged | reviewed | sent |
--                            patient_replied | closed | completed
--   After (this migration):  + pending_parent | closed_no_reply
--
-- BEHAVIORAL IMPACT:
--   * Existing rows: unaffected. No backfill needed; all current
--     status values stay valid.
--   * OPEN_STATUSES in netlify/functions/_lib/routes/queue.js stays
--     unchanged (pending_parent is NOT open — it's queue-hidden
--     until fired). The queue pull / mine endpoints continue to
--     ignore pending_parent rows because the in.() filter doesn't
--     mention it.
--   * Worker (worker.js) picks status='pending' rows only;
--     pending_parent is excluded automatically.
--   * History UI fallbacks (`row.status || ...`) are unaffected
--     since closed_no_reply is just another terminal label.
--
-- PATTERN: mirrors 0012's structure for the urgency_override CHECK
-- (drop the prior constraint, add the wider one). Idempotent.

do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_status_check;
exception when others then null;
end$$;

alter table public.query_history
  add constraint query_history_status_check
  check (status in (
    'pending', 'triaged', 'reviewed', 'sent',
    'patient_replied', 'closed', 'completed',
    'pending_parent', 'closed_no_reply'
  ));
