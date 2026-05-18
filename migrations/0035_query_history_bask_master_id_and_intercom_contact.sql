-- 0035_query_history_bask_master_id_and_intercom_contact.sql
--
-- Two additive columns supporting the second "Order page" deep-link in
-- the tasking SPA's detail-view header:
--
--   * bask_master_id — Bask's Master ID for the patient's order/record.
--     Drives the URL template in RELAI_DEFAULTS.externalSystems.bask
--     .adminOrderUrlTemplate (admin/orders/<master_id>).
--
--   * intercom_contact_id — the Intercom-side contact id (e.g.,
--     "6a0a7f7871c4ad790a391f10"). Needed because the master_id isn't
--     in the webhook payload — we have to fetch the contact via
--     Intercom's GET /contacts/{id} API. Persisting the contact id at
--     insert time means the per-conversation enrichment + the
--     one-off backfill don't have to search by external_id.
--
-- Naming note: Intercom labels the same value `custom_attributes["order id"]`
-- on the contact (lowercase, with a space). Bask refers to it as
-- "Master ID". We use bask_master_id in our schema to match Bask's
-- naming — the field carries semantic weight beyond just an order
-- pointer (it's the durable Master ID, which happens to also drive
-- the admin/orders URL pattern).
--
-- Schema change:
--   * bask_master_id text NULL — Bask's Master ID. UUID-shaped today
--     (e.g., "523da690-873e-4541-878b-555c45b2e596") but kept as text
--     so the schema doesn't break if Bask ever changes the format.
--   * intercom_contact_id text NULL — Intercom's id for the contact.
--     Format is opaque; treat as a black-box token.
--   * Partial index on (company_id, intercom_contact_id) WHERE
--     intercom_contact_id IS NOT NULL — supports "all rows for this
--     contact" lookups and the backfill script's filter.
--
-- Backfill behavior:
--   * intercom_contact_id is backfilled from inbound_raw_event for
--     the audited Intercom events (same pattern as mig 0034 used for
--     bask_patient_id). Older rows without audit entries stay NULL.
--   * bask_master_id is NOT backfilled here — that requires an
--     Intercom API call per unique contact. See
--     scripts/backfill-bask-master-id.js for the one-off enrichment
--     pass; it reads intercom_contact_id (or bask_patient_id, as a
--     fallback) and writes bask_master_id.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists bask_master_id text;

alter table public.query_history
  add column if not exists intercom_contact_id text;

create index if not exists query_history_intercom_contact_id_idx
  on public.query_history (company_id, intercom_contact_id)
  where intercom_contact_id is not null;

-- Backfill intercom_contact_id from audited webhooks. JSON path
-- mirrors the data.item.contacts.contacts[0].id field we now extract
-- in netlify/functions/intercom.js's extractMessage.
update public.query_history qh
set intercom_contact_id = ire.raw_payload->'data'->'item'->'contacts'->'contacts'->0->>'id'
from public.inbound_raw_event ire
where ire.triage_id = qh.id
  and qh.intercom_contact_id is null
  and ire.source_channel = 'intercom'
  and (ire.raw_payload->'data'->'item'->'contacts'->'contacts'->0->>'id') is not null;
