// tests/clinicalDetection.test.js
//
// CONTRACT TEST — enforces that the client's resultIsClinical
// (data/triage-lib.js) and the server's rowIsClinical
// (netlify/functions/_lib/permissions.js) agree on whether a
// given query_history-shaped row should be treated as clinical.
//
// Two implementations exist because the server can't reliably
// require data/triage-lib.js from inside a Netlify Function
// bundle (cross-directory require is fragile under Netlify's
// build). Until that's resolved, the contract test is what
// prevents drift.
//
// If this test ever fails, the two implementations have diverged
// and there's a real safety risk: the client could render a
// clinical-tier inquiry to a non-clinical user using the standard
// view (no handoff banner) because the client thinks it's
// non-clinical while the server's gates would still reject the
// follow-up mutation. Update BOTH copies to match before shipping.

const { resultIsClinical } = require('../data/triage-lib.js');
const { rowIsClinical } = require('../netlify/functions/_lib/permissions.js');

// Battery of test inputs covering every branch of the rule.
// Each input runs through both implementations; if any pair
// disagrees, both assertions fail with a clear diff.
const CASES = [
  // ── Side-effect detection — clinical at every severity ─────
  { name: 'severe SE',                          row: { clinical_routing_level: 'severe' },                                                expected: true },
  { name: 'moderate SE',                        row: { clinical_routing_level: 'moderate' },                                              expected: true },
  { name: 'mild SE',                            row: { clinical_routing_level: 'mild' },                                                  expected: true },
  { name: 'severe SE uppercase',                row: { clinical_routing_level: 'SEVERE' },                                                expected: true },
  { name: 'moderate SE mixed case',             row: { clinical_routing_level: 'Moderate' },                                              expected: true },
  { name: 'SE present + clinical category',     row: { clinical_routing_level: 'mild', clinical_category: 'Injection/Dosing' },           expected: true },
  { name: 'SE present + General Inquiry',       row: { clinical_routing_level: 'severe', clinical_category: 'General Inquiry' },         expected: true },

  // ── No SE, clinical category set ───────────────────────────
  { name: 'no SE + Injection/Dosing',           row: { clinical_routing_level: 'none', clinical_category: 'Injection/Dosing' },           expected: true },
  { name: 'no SE + Side Effects category',      row: { clinical_routing_level: 'none', clinical_category: 'Side Effects' },               expected: true },
  { name: 'no SE + Medication Management',      row: { clinical_routing_level: 'none', clinical_category: 'Medication Management' },      expected: true },
  { name: 'no SE + Stall/Lack of Results',      row: { clinical_routing_level: 'none', clinical_category: 'Stall/Lack of Results' },      expected: true },
  { name: 'no SE + Severe Side Effects cat',    row: { clinical_routing_level: 'none', clinical_category: 'Severe Side Effects' },        expected: true },

  // ── No SE, General Inquiry — NOT clinical ──────────────────
  { name: 'no SE + General Inquiry',            row: { clinical_routing_level: 'none', clinical_category: 'General Inquiry' },            expected: false },
  { name: 'no SE + legacy General/multiple',    row: { clinical_routing_level: 'none', clinical_category: 'General/multiple' },           expected: false },

  // ── Pure non-clinical ──────────────────────────────────────
  { name: 'fully non-clinical',                 row: { clinical_routing_level: 'none', clinical_category: null, non_clinical_flag: true, non_clinical_items: ['Shipment/Tracking'] }, expected: false },
  { name: 'empty row',                          row: {},                                                                                  expected: false },
  { name: 'null row',                           row: null,                                                                                expected: false },
  { name: 'undefined row',                      row: undefined,                                                                           expected: false },

  // ── Missing/blank fields ───────────────────────────────────
  { name: 'whitespace clinical_category',       row: { clinical_routing_level: 'none', clinical_category: '   ' },                        expected: false },
  { name: 'empty string clinical_category',     row: { clinical_routing_level: 'none', clinical_category: '' },                           expected: false },
  { name: 'missing routing level + clin cat',   row: { clinical_category: 'Injection/Dosing' },                                           expected: true },
  { name: 'null routing level + clin cat',      row: { clinical_routing_level: null, clinical_category: 'Side Effects' },                 expected: true },
];

describe('CONTRACT: server rowIsClinical agrees with client resultIsClinical', () => {
  // Each case becomes three assertions: server result, client
  // result, and the expected value. The expected value catches
  // ambient bugs (someone "fixes" both sides to be wrong in the
  // same way); the server-vs-client check catches drift.
  CASES.forEach(({ name, row, expected }) => {
    it('matches on: ' + name, () => {
      const serverResult = rowIsClinical(row);
      const clientResult = resultIsClinical(row);
      assert.equal(
        serverResult,
        expected,
        `server.rowIsClinical(${JSON.stringify(row)}) returned ${serverResult}, expected ${expected}`
      );
      assert.equal(
        clientResult,
        expected,
        `client.resultIsClinical(${JSON.stringify(row)}) returned ${clientResult}, expected ${expected}`
      );
      assert.equal(
        serverResult,
        clientResult,
        `DRIFT: server=${serverResult} but client=${clientResult} for row ${JSON.stringify(row)}`
      );
    });
  });
});

describe('CONTRACT: function names', () => {
  it('both implementations are exposed under documented names', () => {
    // If either name changes, every import in the codebase needs
    // updating. Catching a rename early via this test is cheaper
    // than chasing import errors after deploy.
    assert.equal(typeof rowIsClinical, 'function');
    assert.equal(typeof resultIsClinical, 'function');
  });
});
