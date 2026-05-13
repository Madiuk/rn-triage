// tests/triagePathContract.test.js
//
// CONTRACT TEST — the prior-context wrapper string in app.js's
// runTriage MUST be byte-identical to the one in eval/run.js's
// callTriage. The eval harness exists to be a faithful proxy for
// production behavior; if the wrapper text drifts between the two,
// the eval is silently testing a different prompt than production
// sends, and prompt_version / kb_version hashes still match
// (because the hash covers the system blocks, not the user-content
// wrapper) — so the drift is invisible to every other guard.
//
// The two locations:
//   - app.js (runTriage) — what production sends
//   - eval/run.js (callTriage) — what the eval harness sends
//
// Both files acknowledge this duplication with adjacent comments.
// This test enforces what those comments promise.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Pull out both segments of the wrapper. Each segment lives on a
// single source line in both files. Anchor on the unique opening
// phrases so a future code reformat that splits across lines would
// fail the regex first (with a clearer message than a diff failure).
function extractWrapper(source) {
  // Match the entire single-quoted string literal that starts with
  // "PRIOR CONVERSATION " or with "\n\n---\n\nLATEST PATIENT MESSAGE ".
  // Both files write the wrapper as a `'...'` JS string on one line.
  const m1 = source.match(/'PRIOR CONVERSATION [^']*'/);
  const m2 = source.match(/'\\n\\n---\\n\\nLATEST PATIENT MESSAGE [^']*'/);
  if (!m1 || !m2) {
    throw new Error('wrapper segments not found — has the wrapper been reformatted across multiple lines?');
  }
  return { prior: m1[0], latest: m2[0] };
}

describe('CONTRACT: prior-context wrapper parity (app.js ↔ eval/run.js)', () => {
  const appSrc  = readFile('app.js');
  const evalSrc = readFile('eval/run.js');

  it('both files contain the wrapper segments', () => {
    // Surfaces missing-wrapper as an early, specific failure rather
    // than as a confusing parity diff.
    assert.ok(/PRIOR CONVERSATION \(earlier messages/.test(appSrc),  'app.js missing PRIOR CONVERSATION segment');
    assert.ok(/PRIOR CONVERSATION \(earlier messages/.test(evalSrc), 'eval/run.js missing PRIOR CONVERSATION segment');
    assert.ok(/LATEST PATIENT MESSAGE/.test(appSrc),  'app.js missing LATEST PATIENT MESSAGE segment');
    assert.ok(/LATEST PATIENT MESSAGE/.test(evalSrc), 'eval/run.js missing LATEST PATIENT MESSAGE segment');
  });

  it('PRIOR CONVERSATION segment is byte-identical', () => {
    const a = extractWrapper(appSrc).prior;
    const b = extractWrapper(evalSrc).prior;
    assert.equal(
      a, b,
      'app.js and eval/run.js disagree on the PRIOR CONVERSATION wrapper. Update both copies in the same commit.'
    );
  });

  it('LATEST PATIENT MESSAGE segment is byte-identical', () => {
    const a = extractWrapper(appSrc).latest;
    const b = extractWrapper(evalSrc).latest;
    assert.equal(
      a, b,
      'app.js and eval/run.js disagree on the LATEST PATIENT MESSAGE wrapper. Update both copies in the same commit.'
    );
  });
});

describe('CONTRACT: BASE_PROMPT clinical_category enum matches normalizeTriageOutput', () => {
  // The base prompt instructs the AI to emit clinical_category from a
  // fixed enum. normalizeTriageOutput canonicalizes the model's
  // returned value against its own enum list. If those two lists
  // drift (someone adds a category to BASE_PROMPT but forgets the
  // canonicalizer, or vice versa), production silently emits values
  // that pass through normalization as "unknown trimmed" — clinical
  // category aggregations split, the pill UI stops matching, and
  // kb-promotion's strict-equality check on review_request.context
  // can break too.
  const { BASE_PROMPT_TEMPLATE } = require('../data/base-prompt.js');

  // Canonical list from data/triage-lib.js#normalizeTriageOutput.
  // Pinned here as a literal so this test is the second pair of
  // eyes on every change.
  const CANONICAL_CATEGORIES = [
    'Injection/Dosing',
    'Side Effects',
    'Severe Side Effects',
    'Medication Management',
    'Stall/Lack of Results',
    'General Inquiry',
  ];

  it('every canonical category appears in BASE_PROMPT_TEMPLATE', () => {
    CANONICAL_CATEGORIES.forEach(cat => {
      assert.ok(
        BASE_PROMPT_TEMPLATE.includes(cat),
        `BASE_PROMPT_TEMPLATE is missing canonical category "${cat}". ` +
        `Either add it to the prompt or remove it from normalizeTriageOutput's list.`
      );
    });
  });

  it('BASE_PROMPT_TEMPLATE does not introduce categories the canonicalizer rejects', () => {
    // Extract the explicit enum list from BASE_PROMPT_TEMPLATE — the
    // line "MUST be EXACTLY one of these values — copy it verbatim:".
    // Then assert every quoted token in that line is in the canonical
    // list. Catches additions to the prompt that the canonicalizer
    // doesn't know about.
    const m = BASE_PROMPT_TEMPLATE.match(/MUST be EXACTLY one of these values — copy it verbatim: ([^\n]+)/);
    assert.ok(m, 'BASE_PROMPT_TEMPLATE no longer contains the clinical_category enum sentinel — has the prompt been restructured?');
    const declared = (m[1].match(/"([^"]+)"/g) || []).map(s => s.replace(/^"|"$/g, ''));
    declared.forEach(cat => {
      assert.ok(
        CANONICAL_CATEGORIES.includes(cat),
        `BASE_PROMPT_TEMPLATE declares clinical_category "${cat}" which is NOT in normalizeTriageOutput's canonical list. ` +
        `Either add it to the canonicalizer or remove it from the prompt.`
      );
    });
  });
});
