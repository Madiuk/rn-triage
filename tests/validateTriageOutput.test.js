// tests/validateTriageOutput.test.js
//
// CLINICAL-SENSITIVE tests for the strict enum/range validator.
// Distinct from normalizeTriageOutput (which coerces drift to canon)
// and diffNormalization (which records what was coerced). This
// validator REJECTS drift instead of repairing it — caller routes
// the message to human review on { valid: false }.
//
// CLAUDE.md non-negotiable: "If Claude's classification response is
// malformed, missing required fields, or fails validation, the
// message routes to human review and the failure is logged. Never
// let a bad response flow through to automated routing."

const { validateTriageOutput, applyTripwireOverride } = require('../data/triage-lib');

function validOutput(over) {
  const base = {
    urgency: 'routine',
    clinical_routing_level: 'none',
    ai_confidence: 0.85,
    draft_response: 'Hi — happy to help with that.',
  };
  return Object.assign(base, over || {});
}

describe('validateTriageOutput — happy path', () => {
  it('accepts a canonical output as valid', () => {
    assert.deepEqual(validateTriageOutput(validOutput()), { valid: true });
  });

  it('accepts when ai_confidence is missing (it is optional)', () => {
    const out = validOutput();
    delete out.ai_confidence;
    assert.deepEqual(validateTriageOutput(out), { valid: true });
  });

  it('accepts each urgency enum', () => {
    assert.equal(validateTriageOutput(validOutput({ urgency: 'routine'  })).valid, true);
    assert.equal(validateTriageOutput(validOutput({ urgency: 'same-day' })).valid, true);
    assert.equal(validateTriageOutput(validOutput({ urgency: 'urgent'   })).valid, true);
  });

  it('accepts each clinical_routing_level enum', () => {
    ['severe', 'moderate', 'mild', 'none'].forEach(function(lvl){
      assert.equal(validateTriageOutput(validOutput({ clinical_routing_level: lvl })).valid, true,
        'must accept ' + lvl);
    });
  });

  it('accepts ai_confidence at boundaries 0 and 1', () => {
    assert.equal(validateTriageOutput(validOutput({ ai_confidence: 0 })).valid, true);
    assert.equal(validateTriageOutput(validOutput({ ai_confidence: 1 })).valid, true);
  });
});

describe('validateTriageOutput — rejects non-objects', () => {
  it('rejects null / undefined / scalar inputs', () => {
    [null, undefined, 'urgent', 42, true].forEach(function(input){
      const r = validateTriageOutput(input);
      assert.equal(r.valid, false);
      assert.equal(r.reason, 'not_an_object');
    });
  });
});

describe('validateTriageOutput — rejects urgency drift', () => {
  it('rejects urgency: "URGENT" (casing)', () => {
    const r = validateTriageOutput(validOutput({ urgency: 'URGENT' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_urgency');
    assert.equal(r.field, 'urgency');
  });

  it('rejects urgency: "stat" (made-up value)', () => {
    const r = validateTriageOutput(validOutput({ urgency: 'stat' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_urgency');
  });

  it('rejects urgency: null', () => {
    const r = validateTriageOutput(validOutput({ urgency: null }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_urgency');
  });

  it('rejects urgency: missing entirely', () => {
    const out = validOutput();
    delete out.urgency;
    const r = validateTriageOutput(out);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_urgency');
  });

  it('rejects urgency: "routine " (trailing whitespace, no coercion)', () => {
    // normalizeTriageOutput would trim and accept this. The strict
    // validator does NOT — drift is a signal, not a defect to repair.
    const r = validateTriageOutput(validOutput({ urgency: 'routine ' }));
    assert.equal(r.valid, false);
  });
});

describe('validateTriageOutput — rejects clinical_routing_level drift', () => {
  it('rejects "Severe" (casing)', () => {
    const r = validateTriageOutput(validOutput({ clinical_routing_level: 'Severe' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_clinical_routing_level');
  });

  it('rejects "critical" (made-up value)', () => {
    const r = validateTriageOutput(validOutput({ clinical_routing_level: 'critical' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_clinical_routing_level');
  });
});

describe('validateTriageOutput — rejects ai_confidence drift', () => {
  it('rejects ai_confidence as a string', () => {
    const r = validateTriageOutput(validOutput({ ai_confidence: '0.85' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_ai_confidence_type');
  });

  it('rejects ai_confidence NaN', () => {
    const r = validateTriageOutput(validOutput({ ai_confidence: NaN }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'invalid_ai_confidence_type');
  });

  it('rejects ai_confidence > 1', () => {
    const r = validateTriageOutput(validOutput({ ai_confidence: 1.5 }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'ai_confidence_out_of_range');
  });

  it('rejects ai_confidence < 0', () => {
    const r = validateTriageOutput(validOutput({ ai_confidence: -0.1 }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'ai_confidence_out_of_range');
  });
});

describe('validateTriageOutput — rejects missing/blank draft_response', () => {
  it('rejects empty string', () => {
    const r = validateTriageOutput(validOutput({ draft_response: '' }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing_draft_response');
  });

  it('rejects missing entirely', () => {
    const out = validOutput();
    delete out.draft_response;
    const r = validateTriageOutput(out);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing_draft_response');
  });

  it('rejects non-string draft_response', () => {
    const r = validateTriageOutput(validOutput({ draft_response: 42 }));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'missing_draft_response');
  });
});

describe('applyTripwireOverride', () => {
  it('returns input unchanged when tripwire did not match', () => {
    const out = validOutput();
    const before = JSON.stringify(out);
    applyTripwireOverride(out, null);
    applyTripwireOverride(out, { matched: false });
    assert.equal(JSON.stringify(out), before);
  });

  it('escalates urgency to urgent and routing to severe', () => {
    const out = validOutput({ urgency: 'routine', clinical_routing_level: 'none' });
    applyTripwireOverride(out, { matched: true, category: 'cardiac', keyword: 'chest pain' });
    assert.equal(out.urgency, 'urgent');
    assert.equal(out.clinical_routing_level, 'severe');
  });

  it('sets tripwire_triggered, tripwire_category, route_to_human_review, route_reason', () => {
    const out = validOutput();
    applyTripwireOverride(out, { matched: true, category: 'cardiac', keyword: 'chest pain' });
    assert.equal(out.tripwire_triggered, 'chest pain');
    assert.equal(out.tripwire_category, 'cardiac');
    assert.equal(out.route_to_human_review, true);
    assert.equal(out.route_reason, 'tripwire');
  });

  it('preserves the AI\'s original output in ai_original_output', () => {
    const out = validOutput({
      urgency: 'routine',
      clinical_routing_level: 'none',
      draft_response: 'No worries — common side effect.',
    });
    applyTripwireOverride(out, { matched: true, category: 'cardiac', keyword: 'chest pain' });
    assert.deepEqual(out.ai_original_output, {
      urgency: 'routine',
      clinical_routing_level: 'none',
      draft_response: 'No worries — common side effect.',
    });
  });

  it('replaces draft_response with a non-sendable warning marker', () => {
    const out = validOutput({ draft_response: 'No worries.' });
    applyTripwireOverride(out, { matched: true, category: 'cardiac', keyword: 'chest pain' });
    // The warning marker must contain the keyword AND the category
    // so staff has full context, AND must not look like a real
    // patient-facing reply (no staff should accidentally send it).
    assert.ok(out.draft_response.includes('CLINICAL TRIPWIRE'));
    assert.ok(out.draft_response.includes('chest pain'));
    assert.ok(out.draft_response.includes('cardiac'));
    assert.ok(out.draft_response.includes('respond manually'));
  });

  it('does not downgrade severity when AI already said urgent/severe', () => {
    // The override always SETS to urgent/severe — which means if the
    // AI already said urgent, the value doesn't change. If the AI
    // said e.g. urgency:"same-day", override moves it UP to urgent.
    // This test pins that direction (the override is the floor).
    const out = validOutput({ urgency: 'urgent', clinical_routing_level: 'severe' });
    applyTripwireOverride(out, { matched: true, category: 'cardiac', keyword: 'chest pain' });
    assert.equal(out.urgency, 'urgent');
    assert.equal(out.clinical_routing_level, 'severe');
    // Snapshot still captures what the AI said.
    assert.equal(out.ai_original_output.urgency, 'urgent');
  });
});
