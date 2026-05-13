-- 0015_security_advisor_cleanup.sql
--
-- Closes the findings raised by the Supabase security advisor in May
-- 2026. None of the objects touched here have any references in the
-- application source (grep across netlify/, app.js, login.html, data/,
-- migrations/ — all clean). They are dashboard-era prototypes and
-- leftover permissive policies from before the explicit-deny RLS
-- pattern (see 0011_query_history_explicit_deny_rls.sql) was adopted.
--
-- Idempotent — safe to re-run. Every DROP is guarded with IF EXISTS.
--
-- ─────────────────────────────────────────────────────────────────────
-- 1. Abandoned dashboard tables (ERROR: rls_disabled_in_public)
-- ─────────────────────────────────────────────────────────────────────
--
-- support_kb_entries (15 rows) and support_query_history (0 rows) are
-- pre-multitenancy shapes of kb_entries / query_history. They were
-- never wired up to any code path; nothing reads or writes them. RLS
-- is off on both, meaning anyone with the anon key can read/write the
-- rows.
--
-- snippets (4 rows) is a SECURITY-advisor-flagged table with an
-- `Allow all on snippets` USING(true) policy — effectively no
-- protection. No code references; the only mention in the repo is an
-- unrelated example in AGENTS.md.
--
-- Step 1a: copy the rows into archive tables in public.* with RLS
-- enabled (explicit-deny pattern, same as 0011). Skips support_query_
-- history because it has 0 rows. Wrapped in DO-blocks so the archive
-- step is skipped on re-run (idempotent).

do $$
begin
  if to_regclass('public.support_kb_entries') is not null
     and to_regclass('public.archive_support_kb_entries_20260513') is null then
    execute 'create table public.archive_support_kb_entries_20260513 as table public.support_kb_entries';
    execute 'alter table public.archive_support_kb_entries_20260513 enable row level security';
    execute $c$comment on table public.archive_support_kb_entries_20260513 is 'Archived from public.support_kb_entries on 2026-05-13 by migration 0015_security_advisor_cleanup.sql. RLS-enabled with no policies (explicit deny); only the service key can read.'$c$;
  end if;
end$$;

do $$
begin
  if to_regclass('public.snippets') is not null
     and to_regclass('public.archive_snippets_20260513') is null then
    execute 'create table public.archive_snippets_20260513 as table public.snippets';
    execute 'alter table public.archive_snippets_20260513 enable row level security';
    execute $c$comment on table public.archive_snippets_20260513 is 'Archived from public.snippets on 2026-05-13 by migration 0015_security_advisor_cleanup.sql. RLS-enabled with no policies (explicit deny); only the service key can read.'$c$;
  end if;
end$$;

-- Step 1b: drop the originals. CASCADE removes the snippets
-- `Allow all on snippets` policy along with the table.

drop table if exists public.support_kb_entries cascade;
drop table if exists public.support_query_history cascade;
drop table if exists public.snippets cascade;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Permissive USING(true) policies (WARN: rls_policy_always_true)
-- ─────────────────────────────────────────────────────────────────────
--
-- These policies were created via the Supabase dashboard during early
-- prototyping and never cleaned up. They grant blanket access to
-- anon/authenticated and defeat RLS. The codebase already routes
-- every read/write of these tables through the service key
-- (writeHeaders() in netlify/functions/_lib/supabase.js) with explicit
-- company_id scoping, so dropping these policies leaves the
-- "explicit deny RLS" pattern that 0011 established for query_history.

drop policy if exists "Allow all operations on kb_entries" on public.kb_entries;
drop policy if exists "Company KB"                        on public.kb_entries;
drop policy if exists "Allow all on query_history"        on public.query_history;
drop policy if exists "Company history"                   on public.query_history;
drop policy if exists "Review requests open"              on public.review_requests;

-- ─────────────────────────────────────────────────────────────────────
-- 3. handle_new_user function hardening
--    (WARN: function_search_path_mutable,
--           anon_security_definer_function_executable,
--           authenticated_security_definer_function_executable)
-- ─────────────────────────────────────────────────────────────────────
--
-- The function is a SECURITY DEFINER trigger that copies new
-- auth.users rows into public.profiles. We don't want it callable
-- directly via /rest/v1/rpc by anon/authenticated, and we want a
-- pinned search_path so a future schema-poisoning attempt can't
-- redirect its INSERT to an attacker-controlled table.
--
-- Not dropping the function because it may be wired to an
-- auth.users trigger that pre-populates profiles before the user's
-- first /auth/profile call. (auth.js:82-111 also creates the row if
-- it's missing, so functionally either path works — but the trigger
-- is the cheaper path for invite flows that don't immediately call
-- /auth/profile.)

alter function public.handle_new_user() set search_path = public, pg_temp;
revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Manual follow-up — not SQL-fixable
-- ─────────────────────────────────────────────────────────────────────
--
-- The advisor also flagged `auth_leaked_password_protection` (WARN).
-- That's a Supabase Auth setting, not a database object. Enable it in
-- the dashboard: Authentication → Policies → Password protection →
-- toggle "Check passwords against HaveIBeenPwned.org".
