-- 0028_query_history_conversation_id.sql
--
-- Adds the conversation_id column to query_history so the tasking
-- SPA can render the full thread for a patient conversation, not
-- just the single inbound row that triggered the current task.
--
-- Why we need a dedicated column (instead of just LIKE-matching on
-- external_id):
--   * external_id is uniqueness-shaped: "intercom:<conv>:<part>".
--     The conversation grouping is the prefix.
--   * Querying by prefix isn't index-friendly without a partial
--     index, and ad-hoc prefix matches are easy to get wrong.
--   * Future channels (Healthie, email, manual paste) will have
--     their own thread concept; we want the column to be the
--     canonical answer regardless of channel.
--
-- Schema change:
--   * Add column `conversation_id text` (nullable). NULL is the
--     "no thread concept" answer for manual rows and any other
--     channel that doesn't have an inherent thread identity yet.
--   * Backfill existing Intercom rows by regex-extracting the conv
--     portion of their external_id. Non-Intercom rows stay NULL.
--   * Partial index on (company_id, conversation_id) where
--     conversation_id is not null. Mirrors the partial unique index
--     on external_id from migration 0001.
--
-- BEHAVIORAL IMPACT:
--   * No CHECK constraint, no NOT NULL. The new column is
--     additive only. Routes that don't know about it (worker,
--     intercom write path before this migration's app code lands)
--     simply leave it NULL.
--   * The backfill UPDATE only writes to Intercom-origin rows.
--     Rows from `manual`, `bask`, etc. preserve their NULL.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists conversation_id text;

-- Backfill: extract the conversation portion from external_id for
-- existing Intercom-origin rows. The format laid down in
-- netlify/functions/intercom.js is "intercom:<conv_id>:<part_id>";
-- the regex captures everything between the first and second colon.
-- Re-runs are no-ops thanks to the conversation_id IS NULL guard.
update public.query_history
set conversation_id = substring(external_id from '^intercom:([^:]+):')
where conversation_id is null
  and external_id ~ '^intercom:[^:]+:.+';

-- Partial index for the thread-fetch query (GET /queue/thread).
-- Most rows in the early/single-tenant phase will have a non-NULL
-- conversation_id once Intercom is the primary channel; partial
-- index keeps the structure honest if non-thread channels add rows.
create index if not exists query_history_conversation_id_idx
  on public.query_history (company_id, conversation_id)
  where conversation_id is not null;
