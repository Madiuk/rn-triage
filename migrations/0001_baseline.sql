-- 0001_baseline.sql
-- Captures the schema as it exists in production at the time this file
-- was authored. Idempotent — safe to re-run.

-- Companies (tenants in the original sense)
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz default now()
);

-- Profiles — one row per Supabase Auth user
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  full_name           text,
  role                text,           -- 'Clinical' | 'Non-Clinical' | 'staff'
  company_id          uuid references public.companies(id),
  triages_completed   integer default 0,
  last_seen           timestamptz,
  created_at          timestamptz default now()
);

-- Optional company-membership join (kept for back-compat; many flows
-- now use profiles.company_id directly)
create table if not exists public.company_members (
  company_id  uuid references public.companies(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  role        text,
  created_at  timestamptz default now(),
  primary key (company_id, user_id)
);

-- Knowledge base entries
create table if not exists public.kb_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id),
  section     text not null,    -- sideeffects|templates|protocols|notes|routing|urls
  name        text not null,
  content     text not null,
  position    integer default 0,
  nurse_name  text,
  user_id     uuid,
  updated_at  timestamptz default now(),
  created_at  timestamptz default now()
);
create index if not exists kb_entries_company_section_idx
  on public.kb_entries (company_id, section, position);

-- Triage history
create table if not exists public.query_history (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid references public.companies(id),
  user_id                     uuid,
  nurse_name                  text,
  patient_message             text,
  source_channel              text default 'manual',  -- manual|api|bask
  external_id                 text,                    -- EHR-side id for dedup
  status                      text default 'completed', -- pending|triaged|reviewed|sent|patient_replied|closed|completed
  -- AI output
  clinical_category           text,
  urgency_original            text,
  urgency_override            text,
  urgency_score               integer,
  clinical_routing_level      text default 'none',
  routed_to                   text,
  non_clinical_flag           boolean default false,
  non_clinical_items          jsonb default '[]'::jsonb,
  follow_up_questions         jsonb default '[]'::jsonb,
  draft_response              text,
  -- Staff feedback / correction
  actual_response_sent        text,
  correction_note             text,
  edit_distance               integer,                 -- chars changed (added 0004)
  session_duration_seconds    integer,
  upvoted                     boolean default false,
  upvote_reason               text,
  downvoted                   boolean default false,
  downvote_reason             text,
  -- Severity validation (legacy, no longer collected from UI)
  escalation_validated        boolean default false,
  escalation_correct          boolean,
  -- Bookkeeping
  created_at                  timestamptz default now()
);
create index if not exists query_history_company_created_idx
  on public.query_history (company_id, created_at desc);
create index if not exists query_history_status_idx
  on public.query_history (status) where status <> 'completed';
create unique index if not exists query_history_company_external_unique
  on public.query_history (company_id, external_id)
  where external_id is not null;

-- Review requests (low-confidence triages flagged for clinical expert)
create table if not exists public.review_requests (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid references public.companies(id),
  triage_id           uuid references public.query_history(id),
  created_by          uuid,
  question            text not null,
  context             text,             -- routing|severity|category|kb_gap|protocol|general
  confidence          numeric(3,2),
  patient_message     text,
  ai_draft            text,
  status              text default 'pending', -- pending|resolved|dismissed
  answer              text,
  applied_to          text,             -- kb|correction|confirmation
  resolved_by         uuid,
  resolved_by_name    text,
  resolved_at         timestamptz,
  created_at          timestamptz default now()
);
create index if not exists review_requests_status_idx
  on public.review_requests (company_id, status, created_at desc);

-- API keys for webhook ingest
create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) not null,
  name        text,
  key_hash    text not null unique,    -- sha256(plaintext)
  last_used   timestamptz,
  created_at  timestamptz default now()
);

-- RLS defaults (tighten per-tenant in 0002+ once tenants table arrives)
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.kb_entries enable row level security;
alter table public.query_history enable row level security;
alter table public.review_requests enable row level security;
alter table public.api_keys enable row level security;
