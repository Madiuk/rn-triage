-- 0016_tighten_grants.sql
--
-- Tightens Data API grants on every public table to match actual app
-- usage. The app talks to Supabase exclusively through Netlify
-- functions using SUPABASE_SERVICE_KEY (the `service_role` Postgres
-- role). The anon key and user JWTs are used only for /auth/v1
-- endpoints (sign-in, token refresh) — never for /rest/v1 table
-- access. Audit performed 2026-05-13 against every caller in
-- netlify/, app.js, login.html, data/, tests/, eval/:
--
--   - 100% of /rest/v1 calls use writeHeaders() → service key
--   - readHeaders(token) is used only for /auth/v1/user verification
--   - app.js never hits /rest/v1 directly (all calls proxied through
--     Netlify functions)
--   - No supabase-js, no GraphQL
--
-- So `anon` and `authenticated` have wide-open grants today that the
-- app never actually exercises. Those grants are dead weight, and
-- they make RLS the only thing standing between an attacker with the
-- anon key (which is public; it lives in app.js) and every row.
-- One stray `using (true)` policy added via the dashboard would
-- expose data, even though server code is clean.
--
-- This migration removes that dead weight. After it runs:
--
--   service_role: SELECT, INSERT, UPDATE, DELETE on every table (used)
--   anon:         nothing (not used)
--   authenticated: nothing (not used)
--   public:       nothing (Postgres pseudo-role; defensive revoke)
--
-- Aligns with Supabase's new default for tables created after
-- 2026-10-30 — the README's grants template (added in the prior
-- commit) generates exactly this shape for new tables.
--
-- Idempotent: REVOKE-then-GRANT produces the same final state every
-- run. ROLLBACK at the bottom of this file (commented out) restores
-- the pre-migration ACL if needed.

-- ─────────────────────────────────────────────────────────────────────
-- Helper-free approach: every table is enumerated explicitly so the
-- diff is greppable and the intent is unambiguous. If a future table
-- is added without being listed here, the README template ensures it
-- starts with the right shape — so this migration shouldn't need
-- updating on every new table.
-- ─────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  tables text[] := array[
    'profiles',
    'companies',
    'company_members',
    'kb_entries',
    'query_history',
    'review_requests',
    'api_keys',
    'tenants',
    'audit_log',
    'category_metadata',
    'archive_support_kb_entries_20260513',
    'archive_snippets_20260513'
  ];
begin
  foreach t in array tables
  loop
    -- Skip silently if the table was dropped (defensive — keeps the
    -- migration idempotent on partially-applied environments).
    if to_regclass('public.' || t) is null then
      raise notice 'skipping public.% (does not exist)', t;
      continue;
    end if;

    -- Strip everything from the three non-service roles. ALL covers
    -- SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('revoke all on public.%I from public', t);

    -- service_role keeps the four CRUD verbs the app uses. Other
    -- privileges (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) are
    -- left in place if they were already granted — REVOKE wasn't
    -- run against service_role.
    execute format(
      'grant select, insert, update, delete on public.%I to service_role',
      t
    );
  end loop;
end$$;

-- ─────────────────────────────────────────────────────────────────────
-- Rollback (commented out — uncomment and run if something breaks)
-- ─────────────────────────────────────────────────────────────────────
--
-- do $$
-- declare
--   t text;
--   tables text[] := array[
--     'profiles','companies','company_members','kb_entries',
--     'query_history','review_requests','api_keys','tenants',
--     'audit_log','category_metadata',
--     'archive_support_kb_entries_20260513','archive_snippets_20260513'
--   ];
-- begin
--   foreach t in array tables
--   loop
--     if to_regclass('public.' || t) is null then continue; end if;
--     execute format('grant all on public.%I to anon', t);
--     execute format('grant all on public.%I to authenticated', t);
--   end loop;
-- end$$;
