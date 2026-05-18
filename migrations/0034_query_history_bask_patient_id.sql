-- 0034_query_history_bask_patient_id.sql
--
-- Adds the bask_patient_id column to query_history so the tasking SPA
-- can render a one-click "open in Bask" link in the detail-view
-- header. Bask creates Intercom contacts with the patient's Bask ID
-- in the contact-level external_id field; every Intercom webhook
-- carries that value at data.item.contacts.contacts[0].external_id.
-- We extract it at insert time (see netlify/functions/intercom.js)
-- and the SPA composes the admin URL from a template in
-- RELAI_DEFAULTS.
--
-- Why a dedicated column (vs. parsing the audit JSON on read):
--   * Audit rows (inbound_raw_event) are append-only telemetry, not
--     a queryable lookup surface. Joining query_history → audit on
--     every queue read or detail open would bloat the queries.
--   * Older rows (Kate Palmer's conversation 215474237032428,
--     pre-2026-05-16) have no audit row at all — the audit table
--     shipped in migration 0024 after some of these conversations
--     were already in flight. A dedicated column lets us backfill
--     what we can and accept NULL for the rest.
--
-- Note on naming: this is BASK's identifier for the patient, not
-- Intercom's contact id. From Intercom's perspective the same value
-- is called the contact's `external_id`; calling it bask_patient_id
-- here avoids confusion with query_history.external_id (which is
-- our own per-message id of the form "intercom:<conv>:<part>").
--
-- Schema change:
--   * bask_patient_id text NULL — Bask's patient identifier. Format
--     observed in webhooks is a short numeric string (e.g.,
--     "4707590"), but kept as text because Bask owns the format and
--     could change it.
--   * Partial index on (company_id, bask_patient_id) WHERE
--     bask_patient_id IS NOT NULL — supports "find all tasks for
--     this Bask patient" lookups when we add them (cross-conversation
--     patient history, future feature).
--
-- Backfill: pull contacts[0].external_id from inbound_raw_event rows
-- linked via triage_id. The 39 audited Intercom events get
-- populated; older rows whose audit predates migration 0024 stay
-- NULL. Idempotent — re-runs only touch rows where bask_patient_id
-- is still NULL.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists bask_patient_id text;

create index if not exists query_history_bask_patient_id_idx
  on public.query_history (company_id, bask_patient_id)
  where bask_patient_id is not null;

-- Backfill from audited Intercom events. JSON path mirrors what
-- intercom.js's extractMessage will read going forward.
update public.query_history qh
set bask_patient_id = ire.raw_payload->'data'->'item'->'contacts'->'contacts'->0->>'external_id'
from public.inbound_raw_event ire
where ire.triage_id = qh.id
  and qh.bask_patient_id is null
  and ire.source_channel = 'intercom'
  and (ire.raw_payload->'data'->'item'->'contacts'->'contacts'->0->>'external_id') is not null;
