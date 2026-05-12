-- 0010_roles_admin_categories.sql
--
-- Adds role-based access control plumbing in preparation for Big Easy's
-- multi-staff rollout. Three pieces:
--
--   1. Profile flag columns (is_admin, is_super_user) on top of the
--      existing role column. Roles stay 'Clinical' | 'Non-Clinical'
--      (existing values); admin and super_user are ORTHOGONAL flags.
--      A user is "clinical + admin" or "non-clinical + admin" — admin
--      is a capability, not a base role.
--
--   2. Escalation tracking on query_history. When a non-clinical user
--      sees a message they can't handle (clinical content), they hit
--      "Escalate to clinical" which flips the flag. Clinical's queue
--      surfaces escalated rows distinctly. Also tracks whether the
--      non-clinical handoff template was used (so we can measure
--      what % of inbound messages were CSR-routed vs clinically
--      handled directly).
--
--   3. Per-tenant non-clinical handoff template on companies (the
--      generic "I've passed your message to our nursing team..." reply
--      that non-clinical staff send when they receive a clinical
--      message and need to acknowledge the patient while escalating).
--      Super-user editable.
--
--   4. category_metadata table — per-tenant configurable category
--      list with an is_clinical flag. Non-clinical staff's category
--      picker filters by is_clinical=false. Clinical sees all.
--      Replaces the previously hard-coded category list (which the
--      AI still emits from BASE_PROMPT_TEMPLATE; this table only
--      drives picker visibility, not what the AI generates).
--
-- Idempotent — safe to re-run.
--
-- AFTER RUNNING THIS MIGRATION, set your super-user account:
--   UPDATE public.profiles
--      SET is_admin = true, is_super_user = true
--    WHERE id = '<your auth.users.id>';
-- Find your user id via:
--   SELECT id, email FROM auth.users WHERE email = 'you@example.com';

-- ─────────────────────────────────────────────────────────────────────
-- 1. Profile flag columns
-- ─────────────────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists is_admin boolean not null default false;
alter table public.profiles
  add column if not exists is_super_user boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Escalation tracking on query_history
-- ─────────────────────────────────────────────────────────────────────

alter table public.query_history
  add column if not exists escalated_to_clinical boolean default false;
alter table public.query_history
  add column if not exists escalated_by uuid;
alter table public.query_history
  add column if not exists escalated_at timestamptz;
alter table public.query_history
  add column if not exists non_clinical_handoff_used boolean default false;

-- Index to make "show me unhandled escalated rows" queries fast on
-- the clinical staff's queue view. Partial index — only rows that are
-- actually escalated occupy the index, keeping it tiny.
create index if not exists query_history_escalated_idx
  on public.query_history (company_id, escalated_at desc)
  where escalated_to_clinical = true;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Per-tenant non-clinical handoff template on companies
-- ─────────────────────────────────────────────────────────────────────

alter table public.companies
  add column if not exists non_clinical_handoff_template text
  default 'Thanks for reaching out! I''ve passed your message to our nursing team and they''ll get back to you shortly.';

-- Seed the default for any EXISTING tenant that doesn't have one yet.
-- Column-level DEFAULT only applies on INSERT, so existing rows had
-- NULL until this UPDATE. New tenants get the seed automatically via
-- the column default.
update public.companies
   set non_clinical_handoff_template = 'Thanks for reaching out! I''ve passed your message to our nursing team and they''ll get back to you shortly.'
 where non_clinical_handoff_template is null;

-- ─────────────────────────────────────────────────────────────────────
-- 4. category_metadata table
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.category_metadata (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.companies(id) on delete cascade not null,
  category_name   text not null,
  is_clinical     boolean not null default true,
  display_order   integer default 100,
  is_active       boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(company_id, category_name)
);

create index if not exists category_metadata_picker_idx
  on public.category_metadata (company_id, is_active, is_clinical, display_order);

-- Seed default categories for every existing tenant. These mirror the
-- category enum currently in BASE_PROMPT_TEMPLATE (clinical) and the
-- non_clinical_items enum (non-clinical). is_clinical=true means the
-- category is gated to clinical staff in the picker. General Inquiry
-- is is_clinical=false per the practice's preference (any role can
-- pull tasks tagged General; escalate if it turns out to need a
-- clinician).
insert into public.category_metadata (company_id, category_name, is_clinical, display_order)
select c.id, x.name, x.is_clinical, x.display_order
  from public.companies c
  cross join (values
    -- Clinical categories (gated to clinical staff)
    ('Injection/Dosing',      true,  10),
    ('Side Effects',          true,  20),
    ('Severe Side Effects',   true,  30),
    ('Medication Management', true,  40),
    ('Stall/Lack of Results', true,  50),
    -- Universal category (visible to all roles per practice's request)
    ('General Inquiry',       false, 60),
    -- Non-clinical categories
    ('Billing/Payment',       false, 100),
    ('Shipment/Tracking',     false, 110),
    ('Account/Subscription',  false, 120),
    ('Refund Request',        false, 130),
    ('Complaint/Concern',     false, 140)
  ) as x(name, is_clinical, display_order)
on conflict (company_id, category_name) do nothing;
