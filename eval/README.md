# Eval harness

A frozen set of patient messages with known-good triage outcomes. Run
before every prompt change, KB rewrite, or model upgrade to catch
regressions before they hit production. Re-run on a schedule against
the live deployed prompt to track quality drift.

## How it works

1. Each `eval/cases/*.json` file is a single test case:
   ```json
   {
     "id": "panc-001",
     "description": "Classic pancreatitis red flags",
     "input": {
       "message": "Severe abdominal pain radiating to my back, nauseous, can't keep anything down",
       "prior_context": ""
     },
     "expected": {
       "urgency": "urgent",
       "clinical_routing_level": "severe",
       "clinical_category": ["Severe Side Effects", "Side Effects"],
       "draft_must_include_any": ["911", "ER", "emergency", "provider"]
     }
   }
   ```

2. `eval/run.js` loads every case, runs each through the current
   `BASE_PROMPT` + `DEFAULT_KB`, scores the output, and exits non-zero
   on any failure. Each run also writes a timestamped JSON summary to
   `eval/results/` (gitignored) with per-case outcomes, latency, token
   usage, cost, and the `prompt_version` / `kb_version` hashes that
   produced the run.

3. Scoring rules:
   - `urgency` and `clinical_routing_level` must match exactly
     (case-insensitive).
   - `clinical_category` is an array of acceptable answers — case
     passes if the model's answer contains any one of them
     (substring, case-insensitive). Model drift across closely-related
     categories is tolerated.
   - `non_clinical_flag` must match exactly when specified.
   - `non_clinical_items_includes` — every listed item must appear
     somewhere in `non_clinical_items` (substring, case-insensitive).
   - `draft_must_include_any` — at least one phrase must appear in
     `draft_response` (case-insensitive).
   - `draft_must_not_include` — none of these phrases may appear.

## Running

```sh
# Default: direct Anthropic call against current BASE_PROMPT + DEFAULT_KB.
ANTHROPIC_API_KEY=sk-ant-... npm run eval

# Single case
npm run eval -- --case panc-001

# Through the local function (when running `netlify dev`) — exercises
# the full proxy + cost stamping path the production app uses.
npm run eval -- --endpoint http://localhost:8888/.netlify/functions/triage

# Try a different model (e.g. before switching production)
npm run eval -- --model claude-haiku-4-5
```

## What "pass" actually proves — and doesn't

Pass means the AI's classification fell within the acceptable bands
for these specific frozen cases. It does **not** prove production
quality; production messages are messier and the eval set never covers
the full distribution.

Use the harness as:
- A **regression gate** before merging a prompt or KB change.
- A **calibration check** when model upgrades land — re-run before
  switching the production model.
- A **cost/latency benchmark** — `total_cost_usd`, `mean_latency_ms`,
  and `cache_hit_rate` per run let you spot prompt bloat early.

Use the live `query_history` columns (added in migration 0005:
`prompt_version`, `kb_version`, `cost_usd`, `latency_ms`,
`ai_confidence`, token splits) for production-grade trend analysis.
The eval is the controlled experiment; the live data is the field
study.

## Building the eval set

Curate cases over time. Good sources:
- Past patient messages with clear correct answers
- Cases that staff disagreed with and corrected (especially
  `query_history` rows where `urgency_override` differs from
  `urgency_original`, or where `edit_distance` is large)
- Adverse events / red-flag scenarios you can't afford to miss
- Edge cases (dual-task: clinical + non-clinical in one message)
- Low-confidence cases (`ai_confidence < 0.6`) — confirms whether the
  review threshold is right

Aim for 30–50 cases covering the main category space. Each new case
should be reviewed by a clinical lead before being added — the eval
set is ground truth, so a mislabeled case is worse than no case.

## Updating `expected` when the model legitimately gets better

If a model improvement makes the AI's answer "wrong by the eval but
clearly correct in practice," update the case. Don't lower the bar by
broadening `clinical_category` to include genuinely incorrect answers.
Add a comment in the case JSON explaining when and why the expected
changed; commit the case change in the same commit as the prompt/KB
change that justified it, so the diff explains itself.
