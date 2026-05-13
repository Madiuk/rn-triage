-- 0011_query_history_explicit_deny_rls.sql
--
-- Targeted defense-in-depth for finding 1 of RELAI_DB_INTEGRITY_AUDIT.md:
-- every tenant-scoped table has `enable row level security` but no policies
-- declared anywhere in the migration tree. That makes the deny implicit —
-- a future migration that adds a permissive read/write policy (easy to
-- generate from the Supabase Dashboard's "let me debug" affordance) would
-- be a one-line tenant-isolation break with nothing else flagging it.
--
-- This migration narrows the fix to one table: query_history — the
-- patient-message-bearing table where a relaxation has the highest blast
-- radius. The remaining tables (kb_entries, review_requests, audit_log,
-- etc.) carry the same gap and are out of scope for this change.
--
-- WHAT THIS CHANGES BEHAVIORALLY: nothing. authenticated- and anon-role
-- callers already get zero rows on every query_history operation because
-- RLS is enabled with no policies. After this migration they still get
-- zero rows — but via an explicit, named deny policy that is visible in
-- the schema and in `pg_policies` rather than an absent-policy implicit
-- deny.
--
-- WHAT THIS BUYS: visibility. A future migration that adds a permissive
-- policy on query_history now stands out as a deliberate diff against an
-- explicit baseline. (Postgres OR-combines permissive policies, so the
-- deny does not technically block such a future addition from granting
-- access — the value here is review-time conspicuousness, not runtime
-- enforcement.)
--
-- SERVICE-KEY PATH UNAFFECTED: every Netlify function read/write goes
-- through SUPABASE_SERVICE_KEY (see netlify/functions/_lib/supabase.js's
-- writeHeaders). The service_role role has BYPASSRLS, so policies are
-- skipped entirely on that path. All existing application reads and
-- writes continue to work identically.
--
-- Idempotent — safe to re-run.

do $$
begin
  -- Drop any prior version of this policy so re-runs are no-ops.
  -- Other policies on the table (none today; future additions on
  -- their own names) are left alone.
  begin
    drop policy if exists query_history_user_deny on public.query_history;
  exception when others then null;
  end;

  create policy query_history_user_deny
    on public.query_history
    for all
    to authenticated, anon
    using (false)
    with check (false);
end $$;
