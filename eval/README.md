# Eval harness

A small set of frozen patient messages with known-good triage outcomes.
Run before every prompt change, KB rewrite, or model upgrade to catch
regressions before they hit production.

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

2. `eval/run.js` (to be implemented) loads all cases, calls the triage
   endpoint or Anthropic directly, and scores each output against
   `expected`.

3. Scoring rules:
   - `urgency` and `clinical_routing_level` must match exactly.
   - `clinical_category` is an array of acceptable answers (model
     drift is OK across closely-related categories).
   - `draft_must_include_any` checks that at least one of the listed
     phrases appears in `draft_response`.
   - `draft_must_not_include` (optional) — fail if any phrase appears.

## Building the eval set

Curate cases over time. Good sources:
- Past patient messages with clear correct answers
- Cases that staff disagreed with and corrected
- Adverse events / red-flag scenarios you can't afford to miss
- Edge cases (dual-task: clinical + non-clinical in one message)

Aim for 30–50 cases covering the main category space. Re-run on every
KB rewrite, prompt change, or model upgrade. Track per-case pass/fail
over time as a quality metric.

## Running

```sh
npm run eval        # runs the harness
npm run eval -- --case panc-001   # single case
```

(Both commands TBD — eval/run.js is currently a placeholder.)
