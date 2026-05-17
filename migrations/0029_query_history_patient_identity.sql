-- 0029_query_history_patient_identity.sql
--
-- Adds patient_email and patient_name columns so we can record who
-- the patient is, surface their identity in the tasking SPA, and
-- (later) deep-link to their record in Bask.
--
-- Why this exists: the Intercom webhook payload already includes
-- author.email and author.name for the user-authored part of every
-- event. Until now intercom.js stored author.name in nurse_name
-- (semantically wrong — that column is for the staff member who
-- handled the row, not the patient) and dropped author.email on the
-- floor entirely. Both pieces are needed for staff to identify the
-- patient without bouncing to Intercom, and for Bask integration
-- (its EHR matches patient records by email).
--
-- Schema change:
--   * patient_email text  (nullable; NULL for manual rows and any
--                          ingest path that doesn't carry an email)
--   * patient_name  text  (nullable; same)
--   * Partial index on (company_id, patient_email) for the
--     soon-to-arrive "find every conversation by patient" surface.
--
-- BEHAVIORAL IMPACT:
--   * Additive only. No CHECK constraints, no NOT NULL.
--   * Backfill: copy nurse_name → patient_name for existing Intercom
--     rows that look like patient-side rows (patient_message is set,
--     source_channel is 'intercom'). nurse_name is preserved on
--     those rows for now; a future cleanup can clear it if desired.
--     Backfill is idempotent — re-runs find nothing to do because
--     patient_name gets populated on the first pass.
--   * patient_email is NOT backfilled. We never persisted it on the
--     legacy code path, so there is nothing to backfill from. Only
--     new inserts (post the intercom.js change in this commit) get it.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists patient_email text;

alter table public.query_history
  add column if not exists patient_name text;

-- Backfill patient_name from the (mis-named) nurse_name column for
-- patient-side Intercom rows. Limited to source_channel='intercom'
-- and patient_message is not null so we don't accidentally pull
-- staff names from admin-side rows.
update public.query_history
set patient_name = nurse_name
where patient_name is null
  and source_channel = 'intercom'
  and patient_message is not null
  and nurse_name is not null
  and nurse_name <> 'Intercom';  -- skip the bare fallback string

-- Lookup index for finding every row by a given patient email.
-- Partial so manual rows with no patient_email don't bloat it.
create index if not exists query_history_patient_email_idx
  on public.query_history (company_id, patient_email)
  where patient_email is not null;
