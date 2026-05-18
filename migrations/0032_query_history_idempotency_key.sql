-- 0032_query_history_idempotency_key.sql
--
-- Add idempotency_key to query_history so mutating endpoints that
-- create rows can be safely retried after a transient failure
-- ("Failed to fetch" / Netlify cold-start timeout / edge restart)
-- without producing duplicates.
--
-- Today, only /queue/spawn-followup creates new query_history rows
-- from staff action. If a staffer hits Save → request reaches the
-- server → INSERT succeeds → response is cut on the wire, the
-- staffer sees a network error and retries → without an idempotency
-- key, a second row is inserted.
--
-- Design:
--   * Column is nullable. Existing rows (Intercom inbound, ingest
--     API, manual paste, AI worker output) don't generate keys and
--     aren't affected.
--   * Unique constraint is a partial index — uniqueness is enforced
--     ONLY where idempotency_key is set. Tenant-scoped so two
--     tenants couldn't collide on the same client-generated UUID.
--   * Client (browser) generates a UUIDv4 once per submission
--     attempt and keeps it across retries until success. Server
--     INSERT carries the key; on 23505 unique-violation, the
--     handler looks up the existing row and returns it as success
--     (treats the retry as a no-op confirmation).
--
-- Reversibility: full. Drop the index, then drop the column. No
-- existing query_history data is altered or read by this migration.

alter table public.query_history
  add column if not exists idempotency_key text;

drop index if exists public.query_history_idempotency_key_uq;

create unique index query_history_idempotency_key_uq
  on public.query_history (company_id, idempotency_key)
  where idempotency_key is not null;
