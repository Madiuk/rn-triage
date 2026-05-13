# Migrations

These SQL files are the **single source of truth** for the Supabase
schema. To bring a new environment online, run them in numeric order.

## Conventions

- File naming: `NNNN_short_name.sql` (zero-padded 4 digits, snake_case).
- Each migration must be **idempotent** — use `CREATE TABLE IF NOT
  EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, etc. Re-running a
  migration on an environment that already has it should be a no-op.
- Each migration is **append-only**. Don't edit `0001_baseline.sql`
  after it's been applied; add `0002_*.sql` instead.
- Keep migrations small. One logical concern per file.

## Grants & RLS template for new tables

Supabase is changing its default: starting **2026-10-30**, new tables
created on existing projects will NOT be exposed to the Data API
unless an explicit `GRANT` is in place. PostgREST returns `42501`
with the missing GRANT statement when this happens.

Every `create table` in this directory MUST include the block below.
The app only uses the service key, so `service_role` is the only role
that gets any privileges. `anon` and `authenticated` get nothing —
all reads/writes route through Netlify functions with the service
key, and RLS-enabled-with-no-policies is the second layer of defence.

```sql
create table if not exists public.your_table (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  -- …
  created_at timestamptz default now()
);

-- Data API grants. service_role only; never grant to anon/authenticated.
grant select, insert, update, delete on public.your_table to service_role;

-- Explicit-deny RLS (see 0011_query_history_explicit_deny_rls.sql for the
-- rationale). Service key bypasses RLS, anon/authenticated have neither
-- grants nor policies, so this is closed by default.
alter table public.your_table enable row level security;
```

If a future feature genuinely needs anon or user-JWT direct access
(e.g. a public read-only table), grant only that one verb — never
`all on …`. Match the convention in `0016_tighten_grants.sql`.

## Running them

The fastest path during the trial:
1. Open Supabase → SQL Editor → New Query.
2. Paste a migration file's contents.
3. Run.
4. Repeat for each newer file.

Once we move to a CI/CD setup we'll wire `supabase db push` or a
similar tool. Until then, manual.

## Current schema (as of 0001_baseline)

| Table             | Purpose                                              |
|-------------------|------------------------------------------------------|
| profiles          | Per-user profile (name, role, company_id)            |
| companies         | Tenant orgs                                          |
| company_members   | User ↔ company link (kept for back-compat)           |
| kb_entries        | Knowledge base entries (per-tenant via company_id)   |
| query_history     | Triage records + corrections + feedback              |
| review_requests   | Low-confidence triages for clinical expert input     |
| api_keys          | Webhook API keys (sha256 hashed)                     |
| tenants           | Tenant configuration (theme, defaults) — added 0002  |
| audit_log         | Append-only event log — added 0003                   |

`tenants` and `audit_log` are added by later migrations. Older code
paths fall back to constants in `data/defaults.js` if these tables are
empty, so no behavior change is required to deploy them.
