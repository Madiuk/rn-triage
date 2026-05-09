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
