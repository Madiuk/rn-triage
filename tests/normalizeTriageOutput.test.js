const { normalizeTriageOutput } = require('../data/triage-lib.js');

describe('normalizeTriageOutput', () => {
  it('returns input unchanged for null/undefined/non-objects', () => {
    assert.equal(normalizeTriageOutput(null), null);
    assert.equal(normalizeTriageOutput(undefined), undefined);
    assert.equal(normalizeTriageOutput('string'), 'string');
  });

  it('lowercases urgency uppercase variants', () => {
    assert.equal(normalizeTriageOutput({ urgency: 'URGENT' }).urgency, 'urgent');
    assert.equal(normalizeTriageOutput({ urgency: 'Urgent' }).urgency, 'urgent');
    assert.equal(normalizeTriageOutput({ urgency: '  urgent  ' }).urgency, 'urgent');
    assert.equal(normalizeTriageOutput({ urgency: 'Same-Day' }).urgency, 'same-day');
  });

  it('defaults urgency to "routine" for unknown / missing / non-string', () => {
    assert.equal(normalizeTriageOutput({}).urgency, 'routine');
    assert.equal(normalizeTriageOutput({ urgency: null }).urgency, 'routine');
    assert.equal(normalizeTriageOutput({ urgency: 'asap' }).urgency, 'routine');
    assert.equal(normalizeTriageOutput({ urgency: 42 }).urgency, 'routine');
  });

  it('normalizes clinical_routing_level case', () => {
    assert.equal(normalizeTriageOutput({ clinical_routing_level: 'SEVERE' }).clinical_routing_level, 'severe');
    assert.equal(normalizeTriageOutput({ clinical_routing_level: 'Mild' }).clinical_routing_level, 'mild');
  });

  it('defaults clinical_routing_level to "none" for unknown', () => {
    assert.equal(normalizeTriageOutput({}).clinical_routing_level, 'none');
    assert.equal(normalizeTriageOutput({ clinical_routing_level: 'extreme' }).clinical_routing_level, 'none');
  });

  it('canonicalizes clinical_category to its enum form when matched', () => {
    assert.equal(normalizeTriageOutput({ clinical_category: 'side effects' }).clinical_category, 'Side Effects');
    assert.equal(normalizeTriageOutput({ clinical_category: 'INJECTION/DOSING' }).clinical_category, 'Injection/Dosing');
    assert.equal(normalizeTriageOutput({ clinical_category: '  General Inquiry  ' }).clinical_category, 'General Inquiry');
  });

  it('preserves unknown clinical_category trimmed (does not silently coerce)', () => {
    // We don't want to mask AI mistakes — staff need to see what
    // the AI actually returned and have a chance to correct it.
    assert.equal(normalizeTriageOutput({ clinical_category: 'Bizarre Category' }).clinical_category, 'Bizarre Category');
    assert.equal(normalizeTriageOutput({ clinical_category: '  spaced  ' }).clinical_category, 'spaced');
  });

  it('coerces non_clinical_flag and clinical_routing_flag to booleans', () => {
    var r = normalizeTriageOutput({ non_clinical_flag: 'true', clinical_routing_flag: 1 });
    assert.equal(r.non_clinical_flag, true);
    assert.equal(r.clinical_routing_flag, true);
    var r2 = normalizeTriageOutput({ non_clinical_flag: null, clinical_routing_flag: undefined });
    assert.equal(r2.non_clinical_flag, false);
    assert.equal(r2.clinical_routing_flag, false);
  });

  it('coerces non_clinical_items and follow_up_questions to arrays', () => {
    assert.deepEqual(normalizeTriageOutput({}).non_clinical_items, []);
    assert.deepEqual(normalizeTriageOutput({ non_clinical_items: null }).non_clinical_items, []);
    assert.deepEqual(normalizeTriageOutput({ non_clinical_items: 'not an array' }).non_clinical_items, []);
    assert.deepEqual(normalizeTriageOutput({ non_clinical_items: ['Billing/Payment'] }).non_clinical_items, ['Billing/Payment']);
    assert.deepEqual(normalizeTriageOutput({}).follow_up_questions, []);
  });

  it('clamps ai confidence to [0, 1]', () => {
    assert.equal(normalizeTriageOutput({ review_request: { confidence: 1.5 } }).review_request.confidence, 1);
    assert.equal(normalizeTriageOutput({ review_request: { confidence: -0.2 } }).review_request.confidence, 0);
    assert.equal(normalizeTriageOutput({ review_request: { confidence: 0.7 } }).review_request.confidence, 0.7);
  });

  it('leaves a missing review_request alone', () => {
    var r = normalizeTriageOutput({});
    assert.equal(r.review_request, undefined);
  });

  it('preserves unknown / extra fields', () => {
    var r = normalizeTriageOutput({ urgency: 'urgent', some_future_field: 'value' });
    assert.equal(r.some_future_field, 'value');
  });

  it('does not mutate the input object', () => {
    var input = { urgency: 'URGENT', non_clinical_flag: 1 };
    var r = normalizeTriageOutput(input);
    assert.equal(input.urgency, 'URGENT');
    assert.equal(input.non_clinical_flag, 1);
    assert.equal(r.urgency, 'urgent');
    assert.equal(r.non_clinical_flag, true);
  });

  it('canonicalizes routed_to enum to its enum form when matched', () => {
    assert.equal(normalizeTriageOutput({ routed_to: 'shipping & fulfillment' }).routed_to, 'Shipping & Fulfillment');
    assert.equal(normalizeTriageOutput({ routed_to: 'BILLING TEAM' }).routed_to, 'Billing Team');
  });

  it('preserves unknown routed_to value trimmed', () => {
    assert.equal(normalizeTriageOutput({ routed_to: '  Customer Service Team  ' }).routed_to, 'Customer Service Team');
  });

  it('canonicalizes review_request.context for KB-promotion safety', () => {
    // The resolve handler in kb.js does strict equality `ctx ===
    // "kb_gap"` to decide on promotion. If AI returns 'KB_gap'
    // uppercase, that strict check misses and the answer never
    // reaches the KB. Normalization makes the equality work.
    var r = normalizeTriageOutput({ review_request: { context: 'KB_GAP', confidence: 0.5 } });
    assert.equal(r.review_request.context, 'kb_gap');

    var r2 = normalizeTriageOutput({ review_request: { context: 'Protocol', confidence: 0.6 } });
    assert.equal(r2.review_request.context, 'protocol');
  });

  it('leaves unknown review_request.context unchanged (so resolve handler defaults to no-promote)', () => {
    var r = normalizeTriageOutput({ review_request: { context: 'something_weird', confidence: 0.5 } });
    assert.equal(r.review_request.context, 'something_weird');
  });
});

describe('priorityTier on rows-without-flag (saved-from-DB simulation)', () => {
  // The flag column was never persisted; loaded query_history rows
  // never have clinical_routing_flag. This regression suite proves
  // priorityTier classifies them correctly anyway.
  var { priorityTier } = require('../data/triage-lib.js');

  it('classifies severe SE without flag', () => {
    assert.equal(priorityTier({ clinical_routing_level: 'severe', clinical_category: 'Severe Side Effects' }), 'severe-se');
  });

  it('classifies moderate SE without flag', () => {
    assert.equal(priorityTier({ clinical_routing_level: 'moderate', clinical_category: 'Side Effects' }), 'moderate-se');
  });

  it('classifies mild SE without flag', () => {
    assert.equal(priorityTier({ clinical_routing_level: 'mild', clinical_category: 'Side Effects' }), 'mild-se');
  });

  it('still classifies non-SE clinical correctly (level=none, real category)', () => {
    assert.equal(priorityTier({ clinical_routing_level: 'none', clinical_category: 'Stall/Lack of Results' }), 'clinical');
  });

  it('still classifies non-clinical-only correctly', () => {
    assert.equal(priorityTier({ clinical_routing_level: 'none', clinical_category: 'General Inquiry', non_clinical_flag: true }), 'non-clinical');
  });
});
