-- 0020_rate_limit_ingest.sql
--
-- Per-API-key rate limit on /ingest. Fixed-window algorithm with
-- 1-minute buckets: one row per (api_key_hash, window_start). The
-- handler calls increment_rate_limit() which atomically upserts and
-- returns the new count; handler compares against the limit. Handler
-- fails OPEN on any error from this RPC — a buggy limiter must never
-- block a legitimate triage message. /triage is intentionally NOT
-- rate-limited here (clinical-sensitive path; staff JWT auth + low
-- volume make the threat model different; revisit if auto-send
-- removes the human gate, a triage-specific cost anomaly fires, or a
-- shared multi-tenant proxy changes the surface).
--
-- Storage posture matches 0016: no anon/authenticated grants, RLS
-- enabled with no policies (default deny), service_role only. New
-- tables created after 0016 do not inherit its REVOKEs automatically,
-- so we revoke explicitly below.
--
-- Cleanup: rows persist after their window passes. One row per
-- minute per active key is ~1440/day/key, tiny — no auto-prune for
-- now. Add a periodic delete-where-window_start-older-than-1-day if
-- the table ever grows beyond expectations.
--
-- Idempotent: create-if-not-exists + drop-function-before-create.

create table if not exists public.rate_limit_counter (
  api_key_hash    text        not null,
  window_start    timestamptz not null,
  count           integer     not null default 0,
  primary key (api_key_hash, window_start)
);

create index if not exists rate_limit_counter_window_idx
  on public.rate_limit_counter (window_start);

alter table public.rate_limit_counter enable row level security;

revoke all on public.rate_limit_counter from anon;
revoke all on public.rate_limit_counter from authenticated;
revoke all on public.rate_limit_counter from public;

grant select, insert, update, delete on public.rate_limit_counter to service_role;

-- Atomic upsert+increment, exposed as an RPC. PostgREST has no
-- native increment-on-conflict, so the increment lives in plpgsql
-- and the handler calls it via /rest/v1/rpc/increment_rate_limit.
-- SECURITY DEFINER with a locked search_path so the function runs
-- with the table owner's privileges regardless of caller, but can't
-- be tricked into resolving public.rate_limit_counter to an
-- attacker-controlled schema.

drop function if exists public.increment_rate_limit(text, timestamptz);

create function public.increment_rate_limit(
  p_api_key_hash text,
  p_window       timestamptz
) returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.rate_limit_counter (api_key_hash, window_start, count)
  values (p_api_key_hash, p_window, 1)
  on conflict (api_key_hash, window_start) do update
    set count = public.rate_limit_counter.count + 1
  returning count into v_count;
  return v_count;
end;
$$;

revoke execute on function public.increment_rate_limit(text, timestamptz)
  from anon, authenticated, public;
grant execute on function public.increment_rate_limit(text, timestamptz)
  to service_role;
