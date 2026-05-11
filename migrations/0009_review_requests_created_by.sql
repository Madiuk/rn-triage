-- 0009_review_requests_created_by.sql
-- Reconcile a schema drift between source (0001_baseline.sql declares
-- review_requests.created_by uuid) and production (column is missing,
-- and PostgREST silently drops writes to it because Supabase's
-- default config tolerates unknown fields). The drift was discovered
-- when migration 0008's first attempt failed at the review_requests
-- UPDATE because the column didn't exist.
--
-- Application paths affected by this drift:
--   * kb.js /reviews POST create — `created_by: user.id` was being
--     silently dropped on every review insert since the codebase
--     existed. Functionally invisible because nothing read the
--     column.
--   * app.js saveReviewRequest — same, sends `created_by: getUserId()`
--     in the body, dropped on the way through.
--   * kb.js /reviews POST resolve and dismiss handlers — fallback
--     PATCH WHERE clauses reference `created_by` when callerCompanyId
--     is null. Those WHERE clauses would currently 400 if they
--     fired, but they never fire in production because every
--     profile has a company_id after migration 0008.
--
-- Adding the column closes the drift: future writes from existing
-- code paths land in the right field, and the fallback PATCH WHERE
-- clauses work as written when they're actually needed (e.g., on a
-- fresh tenant before company_id is set).
--
-- Backfills existing rows via the same triage_id chain that 0008
-- used for company_id. Each review.triage_id points to a
-- query_history row whose user_id is the staff member who ran the
-- triage that produced the review request — the most reliable
-- "who" we can recover for historical rows.
--
-- Idempotent. Safe to re-run.

alter table public.review_requests
  add column if not exists created_by uuid;

-- Backfill historical rows where created_by is now null.
update public.review_requests rr
set created_by = qh.user_id
from public.query_history qh
where rr.triage_id = qh.id
  and rr.created_by is null
  and qh.user_id is not null;
