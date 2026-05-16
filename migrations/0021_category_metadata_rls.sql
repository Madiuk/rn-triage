-- 0021_category_metadata_rls.sql
--
-- Defense-in-depth: enable RLS on public.category_metadata. The table
-- is tenant-scoped (company_id FK to public.companies) and was created
-- in 0010 without ENABLE ROW LEVEL SECURITY — every other tenant-scoped
-- table has it. Migration 0016 already revoked all anon/authenticated/
-- public grants so the Data API can't reach this table today, but that
-- relies on the grants list staying complete. RLS-enabled with no
-- policies is default-deny for anon/authenticated; the app talks to
-- category_metadata via service_role (which bypasses RLS), so no
-- policies are needed.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op on re-run.

alter table public.category_metadata enable row level security;
