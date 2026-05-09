#!/usr/bin/env node
// eval/run.js
// Stub eval runner. Loads every case in eval/cases/, calls the triage
// endpoint (or Anthropic directly), scores each output. Wire up the
// real triage call when you're ready to validate against production.

const fs = require('fs');
const path = require('path');

const casesDir = path.join(__dirname, 'cases');
const cases = fs.readdirSync(casesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')));

console.log(`Loaded ${cases.length} eval case(s).`);
cases.forEach(c => console.log(`  - ${c.id}: ${c.description}`));

// TODO: wire up Anthropic call against current BASE_PROMPT + DEFAULT_KB.
// For each case:
//   1. POST to /.netlify/functions/triage with the case's message
//   2. Parse the response
//   3. Score against `expected` rules (urgency match, category match,
//      draft_must_include_any, draft_must_not_include, etc.)
//   4. Print pass/fail per case, summary at end
//   5. Exit non-zero if any case fails

console.log('\n[stub] Triage call not yet wired. See eval/README.md.');
