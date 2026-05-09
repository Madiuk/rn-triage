-- 0003_audit_log.sql
-- Append-only audit log. Every clinical decision and every state
-- change worth replaying lands here. Becomes critical once we have
-- paying customers in regulated contexts.

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id),
  actor_id    uuid,                              -- user that did it (null = system)
  actor_name  text,
  event_type  text not null,                     -- e.g. 'triage.run', 'kb.update', 'review.resolve'
  entity_type text,                              -- 'query_history', 'kb_entry', 'review_request'
  entity_id   uuid,
  payload     jsonb default '{}'::jsonb,         -- arbitrary event detail
  created_at  timestamptz default now()
);

create index if not exists audit_log_company_created_idx
  on public.audit_log (company_id, created_at desc);
create index if not exists audit_log_entity_idx
  on public.audit_log (entity_type, entity_id);

alter table public.audit_log enable row level security;
