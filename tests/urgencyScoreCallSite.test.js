// tests/urgencyScoreCallSite.test.js
//
// Pin the actual `computeUrgencyScore` call shape used by
// app.js#saveHistoryRecord, which is what writes urgency_score to
// query_history. The unit tests in urgencyScore.test.js validate
// the helper; this file validates the CALL SITE — what the helper
// is actually called with in production.
//
// As of this commit, saveHistoryRecord uses the legacy 3-arg
// signature:
//
//     var hasSE = parsed.clinical_routing_flag && (parsed.clinical_routing_level||'none')!=='none';
//     var score = computeUrgencyScore(parsed.urgency, parsed.clinical_routing_level||'none', hasSE);
//
// The 3-arg form CANNOT see clinical_category or non_clinical_flag.
// That makes a difference for two well-defined inputs:
//
//   1. A pure non-clinical-only triage (urgency=routine,
//      non_clinical_flag=true, no SE, no clinical_category).
//      The full 4-arg helper assigns tier=1 (non-clinical only,
//      routine). The 3-arg call-site form falls through to the
//      "unclassified → clinical question" branch and assigns
//      tier=3 instead. Score 3 vs 1.
//
//   2. A non-SE clinical question with clinical_category set
//      (e.g. Injection/Dosing, urgency=routine). The full helper
//      assigns tier=3 (clinical question). The 3-arg form has no
//      clinical_category to inspect, so hasClinicalContent=false;
//      it ALSO falls through to tier=3 (else branch) and lands on
//      the same number — by coincidence, not by design.
//
// This test pins both behaviors so any change to the call site OR
// the helper's back-compat path is caught immediately. If the
// call site is ever updated to pass the parsed object, change the
// expected values in the "current call-site behavior" suite to
// match the new design — and add a comment explaining the
// migration.

const { computeUrgencyScore } = require('../data/triage-lib.js');

// Replicate the EXACT computation used in app.js#saveHistoryRecord.
// Updating this helper's body should ONLY happen when the production
// call site changes.
function callSiteScore(parsed) {
  var hasSE = parsed.clinical_routing_flag && (parsed.clinical_routing_level || 'none') !== 'none';
  return computeUrgencyScore(parsed.urgency, parsed.clinical_routing_level || 'none', hasSE);
}

describe('saveHistoryRecord call-site (legacy 3-arg form) — pinned behavior', () => {
  it('severe SE + urgent → 10 (matches the full helper)', () => {
    assert.equal(callSiteScore({
      urgency: 'urgent',
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      clinical_category: 'Severe Side Effects',
    }), 10);
  });

  it('mild SE + routine → 5 (matches the full helper)', () => {
    assert.equal(callSiteScore({
      urgency: 'routine',
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
      clinical_category: 'Side Effects',
    }), 5);
  });

  it('non-SE clinical question + routine → 3 (call-site happens to agree with the full helper)', () => {
    // Both the full helper and the 3-arg form land on tier=3 here:
    //   - full: hasClinicalContent=true → tier=3
    //   - 3-arg: hasClinicalContent=false (no category passed) → else branch → tier=3
    // Same number, different reasoning. Pinned so a refactor that
    // accidentally changes either path stays caught.
    assert.equal(callSiteScore({
      urgency: 'routine',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: 'Injection/Dosing',
      non_clinical_flag: false,
    }), 3);
  });
});

describe('saveHistoryRecord call-site — KNOWN DISCREPANCY: non-clinical-only triages', () => {
  // These tests document a real divergence between the call site
  // and the design intent of the urgency tier table:
  //
  //   tier table says non-clinical-only routine = 1
  //   tier table says non-clinical-only urgent  = 2
  //   call site (3-arg) writes 3 for both
  //
  // We pin the CURRENT (3-arg) values here. If/when the call site
  // is fixed to pass the parsed object, flip these expectations
  // and document the change.
  //
  // Why the bug isn't visible in production yet: the priority
  // queue uses priorityTier (a separate helper that DOES classify
  // non-clinical correctly), and the urgency_score column is
  // mostly used as a tiebreaker. So the wrong score doesn't
  // change which row sorts to the top in 99% of cases. But it
  // does corrupt urgency-score-by-tier dashboards, and a future
  // gate that reads score directly would be wrong.

  it('non-clinical-only routine — call site writes 3 (full helper would say 1)', () => {
    const parsed = {
      urgency: 'routine',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: '',
      non_clinical_flag: true,
      non_clinical_items: ['Billing/Payment'],
    };
    // Pinning current call-site behavior:
    assert.equal(callSiteScore(parsed), 3, 'call-site behavior');
    // What the helper computes when given the full object:
    assert.equal(computeUrgencyScore(parsed), 1, 'full-object helper');
  });

  it('non-clinical-only urgent — call site writes 4 (full helper would say 2)', () => {
    const parsed = {
      urgency: 'urgent',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: '',
      non_clinical_flag: true,
      non_clinical_items: ['Refund Request'],
    };
    assert.equal(callSiteScore(parsed), 4, 'call-site behavior');
    assert.equal(computeUrgencyScore(parsed), 2, 'full-object helper');
  });

  it('General Inquiry only (no SE, no non-clinical-flag) — call site writes 3, full helper writes 3', () => {
    // Both land on 3. The 3-arg form because of the else branch;
    // the full helper because General Inquiry is excluded from
    // hasClinicalContent and non_clinical_flag is false, so it
    // also falls into the else branch. Same outcome, different
    // path. Pinned to catch regressions in either path.
    const parsed = {
      urgency: 'routine',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: 'General Inquiry',
      non_clinical_flag: false,
    };
    assert.equal(callSiteScore(parsed), 3);
    assert.equal(computeUrgencyScore(parsed), 3);
  });
});

describe('saveHistoryRecord call-site — extracted from app.js (regression guard)', () => {
  // Read app.js and assert the call site we're modeling actually
  // exists. If the line moves, this test fails with a clear pointer
  // rather than the call-site tests above passing on stale logic.
  const fs = require('fs');
  const path = require('path');
  const APP = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');

  it('app.js still calls computeUrgencyScore with the 3-arg signature', () => {
    // If/when this is fixed to pass the parsed object, update both
    // this assertion AND the discrepancy expectations above.
    assert.ok(
      /computeUrgencyScore\(parsed\.urgency, parsed\.clinical_routing_level/.test(APP),
      'app.js no longer calls computeUrgencyScore with the legacy 3-arg form. ' +
      'Update tests/urgencyScoreCallSite.test.js to reflect the new call site.'
    );
  });
});
