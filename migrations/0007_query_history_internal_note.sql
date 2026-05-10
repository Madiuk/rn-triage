-- 0007_query_history_internal_note.sql
-- Persist the AI's internal_note onto every triage row.
--
-- Why: the AI returns an `internal_note` field in its JSON output
-- (described in BASE_PROMPT) — a task-assignment note for the support
-- team summarizing what the non-clinical handoff is. Until now the
-- frontend rendered it in the Routing card and immediately discarded
-- it. Every other AI output field (draft_response, follow_up_questions,
-- non_clinical_items, clinical_category, etc.) is persisted onto
-- query_history; internal_note was the only one being dropped.
--
-- That meant:
--   * We couldn't analyze "did staff act on the AI's routing
--     recommendation?" — we didn't have the recommendation anymore.
--   * Reviewing past triages, we couldn't see what the AI told staff
--     to forward to support.
--   * The eval harness has no way to score AI internal_note quality
--     because we have no ground-truth comparison data accumulating.
--   * The learning loop on routing-quality questions (was the
--     internal_note clear enough? did it omit clinical info as
--     instructed?) has no signal to learn from.
--
-- Idempotent — safe to re-run.

alter table public.query_history
  add column if not exists internal_note text;
