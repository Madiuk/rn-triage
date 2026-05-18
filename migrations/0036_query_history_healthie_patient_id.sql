-- 0036_query_history_healthie_patient_id.sql
--
-- Adds the healthie_patient_id column to query_history for the
-- Healthie channel adapter (netlify/functions/healthie.js).
--
-- Why a dedicated column (vs. reusing bask_patient_id):
--   * The two systems are independent — a patient can be present in
--     both with different identifiers. During the Bask-vs-Healthie
--     transition for Big Easy, the same patient may have two parallel
--     conversation threads, one per system.
--   * Cross-system identity resolution is deferred (see project memory
--     "Bask data available via Intercom contact"). Until that lands,
--     each channel owns its own patient-id column.
--   * The SPA's detail-view header renders one chip per stored ID:
--     "Bask record →" from bask_patient_id (mig 0034) and
--     "Healthie patient →" from healthie_patient_id (this mig). They
--     coexist when both are populated.
--
-- Schema change:
--   * healthie_patient_id text NULL — Healthie's `User.id` for the
--     patient end of the conversation. Healthie uses numeric IDs (e.g.,
--     "2179") but kept as text since Healthie owns the format.
--   * Partial index on (company_id, healthie_patient_id) WHERE the
--     column is non-NULL — supports "find tasks for this Healthie
--     patient" lookups; mirrors the bask_patient_id index pattern.
--
-- BEHAVIORAL IMPACT on existing rows:
--   * NULL by default. Existing Intercom and other rows are unaffected.
--   * No backfill possible from existing data — Healthie webhooks
--     haven't been ingested yet. The column starts NULL across the
--     board and populates as new Healthie webhooks arrive.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists healthie_patient_id text;

create index if not exists query_history_healthie_patient_id_idx
  on public.query_history (company_id, healthie_patient_id)
  where healthie_patient_id is not null;
