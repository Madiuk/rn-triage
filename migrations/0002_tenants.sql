-- 0002_tenants.sql
-- Tenant configuration table. Drives per-tenant brand, theme, and
-- defaults. Single-tenant deployments can ignore this — the app falls
-- back to data/defaults.js when no tenants row exists.

create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null unique references public.companies(id) on delete cascade,
  -- Brand
  brand_name      text not null,
  brand_tag       text,                          -- short tagline shown under brand
  primary_color   text default '#2563eb',
  -- Defaults
  default_response_style  text,                  -- tenant-specific style memory
  allowed_categories      jsonb default '[]'::jsonb,
  escalation_thresholds   jsonb default '{}'::jsonb,
  -- Operations
  is_active       boolean default true,
  trial_ends_at   timestamptz,
  -- Bookkeeping
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Seed Big Easy if it isn't already a row. The app reads tenants by
-- company_id; if no row exists it falls back to data/defaults.js.
insert into public.tenants (company_id, brand_name, brand_tag)
select c.id, c.name, 'Triage and Tasking'
from public.companies c
where c.name = 'Big Easy Weight Loss'
  and not exists (
    select 1 from public.tenants t where t.company_id = c.id
  );

alter table public.tenants enable row level security;
