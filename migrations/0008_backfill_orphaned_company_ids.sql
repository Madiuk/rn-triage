-- 0008_backfill_orphaned_company_ids.sql
-- One-time backfill to repair profiles, query_history, kb_entries, and
-- review_requests rows that were created before the v0.3.6 auto-attach-
-- company_id fix in netlify/functions/auth.js.
--
-- Background:
-- The original auto-create-profile path in auth.js inserted a new row
-- without setting company_id. So users created via Supabase dashboard
-- (or magic-link-with-no-prior-row) ended up with profile.company_id =
-- NULL permanently. Their downstream rows (query_history, kb_entries,
-- review_requests) inherited that null because the frontend reads
-- company_id from the profile (getCompanyId()) and only sets it on
-- inserts when truthy.
--
-- Effect on Juno's first tenant (Big Easy Weight Loss):
--   * Brad's profile had company_id = NULL.
--   * Every triage, every KB save, and every review_request he
--     produced before v0.3.6 had company_id = NULL.
--   * The tenant-scoped aggregations introduced in v0.3.4 silently
--     fell back to user_id scoping for these rows. They worked, but
--     fragility-wise, the "tenant" of these rows was implicit-by-user
--     rather than explicit-by-company.
--
-- This migration:
--   1. Detects whether we're in single-tenant mode (exactly one row
--      in companies). If multi-tenant, skips entirely — admin must
--      manually assign tenants for ambiguous cases.
--   2. Attaches every NULL-company_id profile to the single
--      company.
--   3. Backfills query_history rows whose user_id maps to a profile
--      now in the default company.
--   4. Same for kb_entries (link via user_id).
--   5. For review_requests, walks via triage_id → query_history.id →
--      query_history.user_id → profile.company_id. This avoids any
--      dependency on review_requests.created_by — the original
--      version of this migration tried to use created_by directly,
--      but production schemas may not have that column (it was
--      defined in 0001_baseline but the column may not exist in
--      every deployed schema). The triage_id chain works regardless.
--
-- Idempotent: running again is a no-op once all rows have company_id
-- set.

do $$
declare
  default_company_id uuid;
  company_count int;
  affected_profiles int;
  affected_history int;
  affected_kb int;
  affected_reviews int;
begin
  select count(*) into company_count from public.companies;

  if company_count <> 1 then
    raise notice 'Skipping backfill: companies table has % rows. Multi-tenant — admin must manually assign tenants.', company_count;
    return;
  end if;

  select id into default_company_id from public.companies limit 1;

  -- 1. Profiles
  with updated as (
    update public.profiles
    set company_id = default_company_id
    where company_id is null
    returning 1
  )
  select count(*) into affected_profiles from updated;

  -- 2. query_history rows owned by profiles now in the default company.
  with updated as (
    update public.query_history qh
    set company_id = default_company_id
    from public.profiles p
    where qh.user_id = p.id
      and qh.company_id is null
      and p.company_id = default_company_id
    returning 1
  )
  select count(*) into affected_history from updated;

  -- 3. kb_entries rows owned by profiles now in the default company.
  with updated as (
    update public.kb_entries kb
    set company_id = default_company_id
    from public.profiles p
    where kb.user_id = p.id
      and kb.company_id is null
      and p.company_id = default_company_id
    returning 1
  )
  select count(*) into affected_kb from updated;

  -- 4. review_requests via the triage_id chain. We don't reference
  --    created_by because some deployed schemas don't have that
  --    column (despite 0001_baseline declaring it). The triage_id
  --    foreign key into query_history is universal and reliable:
  --    review.triage_id → query_history.id → query_history.user_id
  --    → profiles.company_id.
  with updated as (
    update public.review_requests rr
    set company_id = default_company_id
    from public.query_history qh
    join public.profiles p on p.id = qh.user_id
    where rr.triage_id = qh.id
      and rr.company_id is null
      and p.company_id = default_company_id
    returning 1
  )
  select count(*) into affected_reviews from updated;

  raise notice 'Backfill complete. Attached to company %:', default_company_id;
  raise notice '  profiles: %', affected_profiles;
  raise notice '  query_history: %', affected_history;
  raise notice '  kb_entries: %', affected_kb;
  raise notice '  review_requests: %', affected_reviews;
end $$;
