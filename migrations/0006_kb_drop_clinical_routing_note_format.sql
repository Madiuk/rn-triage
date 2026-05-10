-- 0006_kb_drop_clinical_routing_note_format.sql
-- Tidy up the live KB to match the v0.3.0 ("Juno") prompt schema.
--
-- Background:
-- Earlier prompt versions had a `clinical_routing_note` field in the
-- AI's JSON output, and the "CLINICAL ROUTING RULES" KB entry told the
-- AI exactly how to format that field. v0.3.0 dropped the field from
-- the prompt schema (the description had been "empty string always
-- (deprecated)" for a while; we removed it entirely). The seed file
-- (data/default-kb.js) was updated in the same release.
--
-- Tenants whose KB was seeded from the older default still have the
-- old format-instruction lines in their live KB row. The AI ignores
-- the dead lines because the schema no longer has the field, but
-- they're noise — they cost prompt tokens and they create an
-- eval-vs-production drift (eval uses the seed, prod uses the live KB).
--
-- This migration patches the live KB row in place. Idempotent: re-runs
-- only if the old format-instruction text still appears.
--
-- This migration does NOT add or drop any columns. There is no
-- `clinical_routing_note` column on `query_history` — it was a
-- JSON-output-only field, never persisted. Don't go looking for it.

-- Strip every `clinical_routing_note format: ...` paragraph and the
-- preceding "and clinical_routing_note" mention from the rules header,
-- across every tenant's CLINICAL ROUTING RULES entry.
update public.kb_entries
set content = regexp_replace(
  regexp_replace(
    content,
    '\n?clinical_routing_note format:[^\n]*',
    '',
    'g'
  ),
  ', and clinical_routing_note',
  '',
  'g'
)
where section = 'routing'
  and name = 'CLINICAL ROUTING RULES'
  and content ~ 'clinical_routing_note';
