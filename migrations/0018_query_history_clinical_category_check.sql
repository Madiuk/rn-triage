-- 0018_query_history_clinical_category_check.sql
--
-- Defense-in-depth for finding 2 of RELAI_DB_INTEGRITY_AUDIT.md,
-- continuing the work in 0012-0014. Adds the CHECK on the
-- query_history.clinical_category column. 0012's header listed this
-- column as deferred ("same finding, separate columns") — this
-- migration closes that piece.
--
-- ALLOWLIST: 'Injection/Dosing' | 'Side Effects' | 'Severe Side Effects'
--            | 'Medication Management' | 'Stall/Lack of Results'
--            | 'General Inquiry'
--
-- Canonical source: normalizeTriageOutput in data/triage-lib.js
-- (the canonicalCategories array). The companion test asserts
-- set-equality so neither side can drift.
--
-- DESIGN NOTE — TRADEOFF MADE HERE:
--   normalizeTriageOutput preserves unknown clinical_category values
--   trimmed rather than coercing them, "so staff can see what the AI
--   actually returned and correct it" (data/triage-lib.js:54-66).
--   This migration's strict allowlist BREAKS that behavior for FUTURE
--   rows: when the AI emits something outside the enum, the row
--   insert will fail instead of saving the drift signal for staff
--   review.
--
--   For EXISTING rows, this migration is more careful. The pre-launch
--   query_history table contains legacy taxonomy values from before
--   the current 6-category enum existed (e.g. "Dosing question",
--   "GI side effects", "Weight plateau", multi-value lists like
--   "Side Effects, Medication Management", and the deprecated
--   "X | Non-clinical: …" suffix format). Of 135 rows, 73 carried
--   off-enum values when this migration was authored. A naive backfill
--   would null all 73; this migration instead canonicalizes the
--   recoverable signal (~69 rows) and nulls only the genuinely
--   unmappable residue (~4 rows: empty strings, empty clinical
--   prefixes, and "Urgent-escalate" which was an urgency value
--   incorrectly stored in this column).
--
--   The legacy→canonical mapping below was reviewed and approved by
--   the clinical owner (Brad, RN/former 911 paramedic) — the SAME
--   person who would be reading the historical aggregations and
--   needs them to remain clinically meaningful after this migration.
--
--   If the strict allowlist itself turns out to be the wrong call,
--   this migration is reversible: drop the constraint with
--   `alter table public.query_history drop constraint
--    query_history_clinical_category_check;`
--   and replace with a length-only CHECK in a follow-up migration.
--   (The legacy→canonical canonicalization is NOT reversible — the
--   pre-canonicalization values are not retained anywhere.)
--
-- BEHAVIORAL IMPACT:
--   * Valid rows (NULL or one of the six allowlisted values): no
--     effect.
--   * Legacy rows with a recoverable mapping: rewritten to the
--     canonical form (see step 1 below).
--   * Legacy rows with no clean mapping (empty, empty-prefix
--     "| Non-clinical: …", "Urgent-escalate"): backfilled to NULL.
--     Downstream readers handle NULL clinical_category by rendering
--     the row with no category pill.
--
-- CONTRACT: the allowlist below must stay set-equal to the
-- canonicalCategories array in normalizeTriageOutput. The companion
-- test enforces parity so neither side can drift.
--
-- Idempotent — safe to re-run. The canonicalization UPDATE has a
-- WHERE clause restricted to off-enum values, so a second run skips
-- already-canonical rows.

-- 1. CANONICALIZATION PASS. Rewrite recoverable legacy values to
--    their canonical form. WHERE clause restricts to off-enum rows
--    so already-canonical rows are not touched (idempotent).
--
--    Mapping rules (clinical owner approved):
--      - Single-value legacy names → canonical equivalent.
--      - Multi-value comma/pipe lists → first canonical token.
--      - "X | Non-clinical: Y" suffix format → X (suffix stripped),
--        then canonicalized if needed.
--      - "+ Other" / "+ X" appendix → canonicalize the lead token.
--      - Genuinely unmappable (empty, empty-clinical-prefix,
--        "Urgent-escalate"): NULL.
update public.query_history
set clinical_category = case clinical_category
  -- Single-value legacy names
  when 'Dosing question'                          then 'Injection/Dosing'
  when 'Injection/administration'                 then 'Injection/Dosing'
  when 'GI side effects'                          then 'Side Effects'
  when 'Skin/site reaction'                       then 'Side Effects'
  when 'Diarrhea'                                 then 'Side Effects'
  when 'Hair loss'                                then 'Side Effects'
  when 'Heartburn/reflux'                         then 'Side Effects'
  when 'Medication storage'                       then 'Medication Management'
  when 'Weight plateau'                           then 'Stall/Lack of Results'
  when 'General/multiple'                         then 'General Inquiry'
  when 'General / multiple'                       then 'General Inquiry'

  -- Multi-value comma lists → first canonical token
  when 'Injection/Dosing, Medication Management'                            then 'Injection/Dosing'
  when 'Injection/Dosing, General Inquiry'                                  then 'Injection/Dosing'
  when 'Injection/Dosing, Medication Management, General Inquiry'           then 'Injection/Dosing'
  when 'Injection/Dosing, Medication Management, Stall/Lack of Results'     then 'Injection/Dosing'
  when 'Medication Management, Stall/Lack of Results'                       then 'Medication Management'
  when 'Medication Management, General Inquiry'                             then 'Medication Management'
  when 'Side Effects, Medication Management'                                then 'Side Effects'
  when 'Side Effects, Medication Management, Stall/Lack of Results'         then 'Side Effects'

  -- "+ X" appendix patterns → canonicalize the lead token
  when 'Dosing question + Other'                  then 'Injection/Dosing'
  when 'Dosing question + Shipment/Tracking'      then 'Injection/Dosing'
  when 'General + Account/Subscription'           then 'General Inquiry'

  -- Pipe + Non-clinical suffix variants (strip suffix, canonicalize lead)
  when 'Side Effects | Non-clinical: Shipment/Tracking'                then 'Side Effects'
  when 'Injection/Dosing | Non-clinical: Complaint/Concern'            then 'Injection/Dosing'
  when 'Stall/Lack of Results | Non-clinical: Billing/Payment'         then 'Stall/Lack of Results'
  when 'General/multiple | Non-clinical: Other'                        then 'General Inquiry'
  when 'Diarrhea [SE: Diarrhea] | Non-clinical: Shipment/Tracking, Package not received' then 'Side Effects'

  -- Comma/pipe lists with non-canonical lead → first CANONICAL token
  when 'Food noise/cravings, Dosing question'     then 'Injection/Dosing'
  when 'Food noise/cravings|Dosing question'      then 'Injection/Dosing'

  -- Genuinely unmappable → NULL. The CASE returns NULL, the UPDATE
  -- writes NULL.
  when 'Urgent-escalate'                                             then null
  when ''                                                            then null
  when ' | Non-clinical: Account/Subscription'                       then null
  when ' | Non-clinical: Billing/Payment, Shipment/Tracking'         then null
  when ' | Non-clinical: Shipment/Tracking'                          then null
  when ' | Non-clinical: Shipment/Tracking, Account/Subscription'    then null

  -- Defensive fall-through. If a value not enumerated above somehow
  -- appears (new legacy variant we didn't see during planning), the
  -- safety-net backfill in step 2 nulls it before the CHECK lands.
  else clinical_category
end
where clinical_category is not null
  and clinical_category not in (
    'Injection/Dosing',
    'Side Effects',
    'Severe Side Effects',
    'Medication Management',
    'Stall/Lack of Results',
    'General Inquiry'
  );

-- 2. SAFETY-NET BACKFILL. Catches any off-enum value not handled by
--    step 1's CASE statement (e.g., a new legacy variant we didn't
--    see during planning). Idempotent. After step 1, this should
--    typically affect zero rows.
update public.query_history
set clinical_category = null
where clinical_category is not null
  and clinical_category not in (
    'Injection/Dosing',
    'Side Effects',
    'Severe Side Effects',
    'Medication Management',
    'Stall/Lack of Results',
    'General Inquiry'
  );

-- 3. Drop any prior version of this constraint.
do $$
begin
  alter table public.query_history
    drop constraint if exists query_history_clinical_category_check;
exception when others then null;
end$$;

-- 4. Add the CHECK.
alter table public.query_history
  add constraint query_history_clinical_category_check
  check (
    clinical_category is null
    or clinical_category in (
      'Injection/Dosing',
      'Side Effects',
      'Severe Side Effects',
      'Medication Management',
      'Stall/Lack of Results',
      'General Inquiry'
    )
  );
