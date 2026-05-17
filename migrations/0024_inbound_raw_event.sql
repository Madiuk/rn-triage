-- 0024_inbound_raw_event.sql
--
-- Audit / observability table for inbound webhook events. Captures
-- every payload that arrives at a channel adapter (intercom.js
-- today; future healthie.js / bask.js will use the same shape) AFTER
-- the adapter's signature/HMAC verification passes — so the boundary
-- between "untrusted internet" and "trusted channel" is preserved
-- (signature failures are still logged via structured logger but
-- not stored here, to avoid persisting arbitrary attacker payloads).
--
-- Originally deferred per PLAN.md "Hardening batch" 2026-05-15 with
-- the trigger condition "until Bask/Intercom webhook contracts are
-- real." Intercom is live as of 2026-05-16; this migration satisfies
-- the trigger condition. The 2026-05-17 "SYSTEM MESSAGE: CONVERSATION
-- STARTED" investigation is the motivating use case: without raw
-- payloads we can only string-match what we observe; with them we
-- can inspect source.type / source.delivered_as / source.author
-- structure and write proper structural filters.
--
-- Schema:
--   id              — uuid PK
--   company_id      — tenant FK; NULL allowed only for events that
--                     arrive before tenant resolution (rare; today's
--                     intercom.js resolves company_id from env)
--   source_channel  — 'intercom' | 'healthie' | 'bask' | 'email' | ...
--   topic           — channel-specific event name (free-text;
--                     'conversation.user.created' for Intercom, etc.)
--   external_id     — channel's stable id for the event (intercom:conv:part).
--                     NOT unique here — duplicate-delivered events all
--                     get audit rows; the uniqueness gate lives on
--                     query_history.external_id only.
--   raw_payload     — full webhook body as JSON
--   processed       — true if a query_history row was created from this
--   processed_reason — human-readable disposition: 'inserted' |
--                     'duplicate' | 'system_placeholder' |
--                     'unsupported_topic' | 'empty_after_strip' |
--                     'no_user_message' | 'fin_participated_*' (etc.)
--   triage_id       — FK to the resulting query_history row when
--                     processed=true; NULL otherwise. ON DELETE SET
--                     NULL so a row deletion doesn't cascade-delete
--                     its provenance.
--   created_at      — when we received the event
--
-- Indexes:
--   recent_idx  — (company_id, created_at desc) for "show me what
--                 came in last hour" diagnostic queries
--   topic_idx   — (source_channel, topic) for "how often does
--                 conversation.user.created fire" counts
--
-- RLS: enabled with an explicit deny for authenticated/anon. Service
-- role (Netlify functions via SUPABASE_SERVICE_KEY) bypasses RLS for
-- writes + diagnostic reads. Same pattern as task_reassignments in 0022.
--
-- Idempotent — safe to re-run.

create table if not exists public.inbound_raw_event (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid references public.companies(id) on delete cascade,
  source_channel    text not null,
  topic             text,
  external_id       text,
  raw_payload       jsonb not null,
  processed         boolean not null default false,
  processed_reason  text,
  triage_id         uuid references public.query_history(id) on delete set null,
  created_at        timestamptz default now()
);

create index if not exists inbound_raw_event_recent_idx
  on public.inbound_raw_event (company_id, created_at desc);

create index if not exists inbound_raw_event_topic_idx
  on public.inbound_raw_event (source_channel, topic);

-- RLS: enable + explicit deny for authenticated/anon. Service-role
-- (Netlify functions via SUPABASE_SERVICE_KEY) bypasses RLS, so all
-- inbound channel writers continue to work normally.
alter table public.inbound_raw_event enable row level security;

do $$
begin
  begin
    drop policy if exists inbound_raw_event_user_deny on public.inbound_raw_event;
  exception when others then null;
  end;

  create policy inbound_raw_event_user_deny
    on public.inbound_raw_event
    for all
    to authenticated, anon
    using (false)
    with check (false);
end $$;
