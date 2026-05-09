const { computeUrgencyScore, priorityTier, taskShape, formatDuration, levenshteinDistance } = require('../data/triage-lib.js');

// Helper to build a parsed-style object for the new signature.
function p(opts) {
  return Object.assign({
    urgency: 'routine',
    clinical_routing_flag: false,
    clinical_routing_level: 'none',
    clinical_category: '',
    non_clinical_flag: false,
  }, opts);
}

describe('computeUrgencyScore — new tiered scale', () => {
  it('severe side effect, urgent = 10', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'urgent',
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      clinical_category: 'Severe Side Effects',
    })), 10);
  });

  it('severe side effect, same-day = 9', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'same-day',
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      clinical_category: 'Severe Side Effects',
    })), 9);
  });

  it('moderate side effect, urgent = 8', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'urgent',
      clinical_routing_flag: true,
      clinical_routing_level: 'moderate',
      clinical_category: 'Side Effects',
    })), 8);
  });

  it('moderate side effect, same-day = 7', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'same-day',
      clinical_routing_flag: true,
      clinical_routing_level: 'moderate',
      clinical_category: 'Side Effects',
    })), 7);
  });

  it('mild side effect, urgent = 6', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'urgent',
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
      clinical_category: 'Side Effects',
    })), 6);
  });

  it('mild side effect, routine = 5', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'routine',
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
      clinical_category: 'Side Effects',
    })), 5);
  });

  it('clinical question (no side effect), urgent = 4', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'urgent',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: 'Injection/Dosing',
    })), 4);
  });

  it('clinical question (no side effect), routine = 3', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'routine',
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: 'Injection/Dosing',
    })), 3);
  });

  it('non-clinical only, urgent = 2', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'urgent',
      non_clinical_flag: true,
      clinical_category: '',
    })), 2);
  });

  it('non-clinical only, routine = 1', () => {
    assert.equal(computeUrgencyScore(p({
      urgency: 'routine',
      non_clinical_flag: true,
      clinical_category: '',
    })), 1);
  });

  it('side effect always outranks plain clinical question (severe routine > clinical urgent)', () => {
    var sevRoutine = computeUrgencyScore(p({
      urgency: 'routine',
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      clinical_category: 'Severe Side Effects',
    }));
    var clinUrgent = computeUrgencyScore(p({
      urgency: 'urgent',
      clinical_category: 'Injection/Dosing',
    }));
    assert.ok(sevRoutine > clinUrgent, sevRoutine + ' should be > ' + clinUrgent);
  });

  it('clinical always outranks non-clinical-only', () => {
    var clinRoutine = computeUrgencyScore(p({
      urgency: 'routine',
      clinical_category: 'Injection/Dosing',
    }));
    var nonClinUrgent = computeUrgencyScore(p({
      urgency: 'urgent',
      non_clinical_flag: true,
    }));
    assert.ok(clinRoutine > nonClinUrgent);
  });

  it('legacy 3-arg signature still works (back-compat)', () => {
    // (urgency, routingLevel, hasSideEffect)
    assert.equal(computeUrgencyScore('urgent', 'severe', true), 10);
    assert.equal(computeUrgencyScore('routine', 'moderate', true), 7);
    assert.equal(computeUrgencyScore('routine', 'none', false), 3);
  });

  it('General Inquiry category alone is not "clinical content"', () => {
    var s = computeUrgencyScore(p({
      urgency: 'routine',
      clinical_category: 'General Inquiry',
      non_clinical_flag: true,
    }));
    assert.equal(s, 1);
  });
});

describe('taskShape', () => {
  it('clinical only is single', () => {
    assert.equal(taskShape({
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
      clinical_category: 'Side Effects',
    }), 'single');
  });

  it('non-clinical only is single', () => {
    assert.equal(taskShape({
      non_clinical_flag: true,
      non_clinical_items: ['Shipment/Tracking'],
    }), 'single');
  });

  it('side effect + non-clinical is dual', () => {
    assert.equal(taskShape({
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
      clinical_category: 'Side Effects',
      non_clinical_flag: true,
      non_clinical_items: ['Shipment/Tracking'],
    }), 'dual');
  });

  it('clinical question (no SE) + non-clinical is dual', () => {
    assert.equal(taskShape({
      clinical_routing_flag: false,
      clinical_routing_level: 'none',
      clinical_category: 'Injection/Dosing',
      non_clinical_flag: true,
    }), 'dual');
  });

  it('General Inquiry + non-clinical is single (no real clinical content)', () => {
    assert.equal(taskShape({
      clinical_category: 'General Inquiry',
      non_clinical_flag: true,
    }), 'single');
  });

  it('non_clinical_items array alone counts as non-clinical', () => {
    assert.equal(taskShape({
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      non_clinical_items: ['Billing/Payment'],
    }), 'dual');
  });

  it('handles null parsed', () => {
    assert.equal(taskShape(null), 'single');
  });
});

describe('priorityTier', () => {
  it('classifies severe side effect', () => {
    assert.equal(priorityTier({
      clinical_routing_flag: true,
      clinical_routing_level: 'severe',
      clinical_category: 'Severe Side Effects',
    }), 'severe-se');
  });
  it('classifies moderate side effect', () => {
    assert.equal(priorityTier({
      clinical_routing_flag: true,
      clinical_routing_level: 'moderate',
    }), 'moderate-se');
  });
  it('classifies mild side effect', () => {
    assert.equal(priorityTier({
      clinical_routing_flag: true,
      clinical_routing_level: 'mild',
    }), 'mild-se');
  });
  it('classifies non-side-effect clinical', () => {
    assert.equal(priorityTier({
      clinical_category: 'Injection/Dosing',
    }), 'clinical');
  });
  it('classifies non-clinical only', () => {
    assert.equal(priorityTier({
      non_clinical_flag: true,
    }), 'non-clinical');
  });
});

describe('formatDuration', () => {
  it('returns em-dash for null/zero/negative', () => {
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(0), '—');
    assert.equal(formatDuration(-5), '—');
  });

  it('formats seconds under a minute', () => {
    assert.equal(formatDuration(12), '12s');
    assert.equal(formatDuration(59), '59s');
  });

  it('formats minutes only when no remainder', () => {
    assert.equal(formatDuration(60), '1m');
    assert.equal(formatDuration(120), '2m');
  });

  it('formats minutes + seconds otherwise', () => {
    assert.equal(formatDuration(75), '1m 15s');
    assert.equal(formatDuration(125), '2m 5s');
  });
});

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshteinDistance('hello', 'hello'), 0);
  });

  it('returns length for empty input', () => {
    assert.equal(levenshteinDistance('', 'abc'), 3);
    assert.equal(levenshteinDistance('abc', ''), 3);
  });

  it('counts single substitution', () => {
    assert.equal(levenshteinDistance('cat', 'bat'), 1);
  });

  it('counts insertion', () => {
    assert.equal(levenshteinDistance('cat', 'cats'), 1);
  });

  it('counts deletion', () => {
    assert.equal(levenshteinDistance('cats', 'cat'), 1);
  });

  it('handles longer edits', () => {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
  });

  it('treats null inputs as empty', () => {
    assert.equal(levenshteinDistance(null, 'abc'), 3);
    assert.equal(levenshteinDistance('abc', null), 3);
  });
});
