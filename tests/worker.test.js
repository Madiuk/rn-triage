const {
  buildTriagePatch,
  buildFinSkipPatch,
  FIN_SKIP_NOTE,
} = require('../netlify/functions/worker.js');

describe('buildFinSkipPatch', () => {
  it('returns status=reviewed', () => {
    assert.equal(buildFinSkipPatch().status, 'reviewed');
  });

  it('includes an internal_note that mentions Fin and human review', () => {
    const patch = buildFinSkipPatch();
    assert.equal(typeof patch.internal_note, 'string');
    assert.ok(patch.internal_note.length > 0);
    assert.ok(/Fin/.test(patch.internal_note), 'note should reference Fin');
    assert.ok(/human review/i.test(patch.internal_note), 'note should mention human review');
  });

  it('matches the exported FIN_SKIP_NOTE constant', () => {
    assert.equal(buildFinSkipPatch().internal_note, FIN_SKIP_NOTE);
  });
});

describe('buildTriagePatch — status transition', () => {
  it('returns status=triaged when route_to_human_review is not set', () => {
    const patch = buildTriagePatch({ urgency: 'routine', clinical_routing_level: 'none' }, {});
    assert.equal(patch.status, 'triaged');
  });

  it('returns status=reviewed when route_to_human_review is true', () => {
    const patch = buildTriagePatch({ urgency: 'routine' }, { route_to_human_review: true });
    assert.equal(patch.status, 'reviewed');
  });

  it('returns status=triaged when route_to_human_review is explicitly false', () => {
    const patch = buildTriagePatch({ urgency: 'routine' }, { route_to_human_review: false });
    assert.equal(patch.status, 'triaged');
  });
});

describe('buildTriagePatch — classification fields', () => {
  it('passes through canonical enum values from normalized', () => {
    const patch = buildTriagePatch({
      urgency: 'urgent',
      clinical_routing_level: 'severe',
      clinical_category: 'Side Effects',
      draft_response: 'Reply text',
      routed_to: 'Pharmacy Team',
      internal_note: 'staff context',
    }, {});
    assert.equal(patch.urgency_original, 'urgent');
    assert.equal(patch.clinical_routing_level, 'severe');
    assert.equal(patch.clinical_category, 'Side Effects');
    assert.equal(patch.draft_response, 'Reply text');
    assert.equal(patch.routed_to, 'Pharmacy Team');
    assert.equal(patch.internal_note, 'staff context');
  });

  it('defaults clinical_routing_level to "none" when missing (DB CHECK compatible)', () => {
    const patch = buildTriagePatch({ urgency: 'routine' }, {});
    assert.equal(patch.clinical_routing_level, 'none');
  });

  it('sets clinical_category to null when missing', () => {
    assert.equal(buildTriagePatch({}, {}).clinical_category, null);
  });

  it('sets urgency_original to null when missing', () => {
    assert.equal(buildTriagePatch({}, {}).urgency_original, null);
  });

  it('computes urgency_score as a number', () => {
    const patch = buildTriagePatch({ urgency: 'urgent', clinical_routing_level: 'severe' }, {});
    assert.equal(typeof patch.urgency_score, 'number');
  });

  it('defaults draft_response to empty string when missing', () => {
    assert.equal(buildTriagePatch({}, {}).draft_response, '');
  });

  it('defaults routed_to to null', () => {
    assert.equal(buildTriagePatch({}, {}).routed_to, null);
  });

  it('defaults internal_note to null', () => {
    assert.equal(buildTriagePatch({}, {}).internal_note, null);
  });
});

describe('buildTriagePatch — ai_confidence range guard', () => {
  it('passes through a valid in-range confidence', () => {
    assert.equal(buildTriagePatch({ ai_confidence: 0.85 }, {}).ai_confidence, 0.85);
  });

  it('accepts boundary values 0 and 1', () => {
    assert.equal(buildTriagePatch({ ai_confidence: 0 }, {}).ai_confidence, 0);
    assert.equal(buildTriagePatch({ ai_confidence: 1 }, {}).ai_confidence, 1);
  });

  it('rejects values > 1 (would violate DB CHECK)', () => {
    assert.equal(buildTriagePatch({ ai_confidence: 1.5 }, {}).ai_confidence, null);
  });

  it('rejects negative values (would violate DB CHECK)', () => {
    assert.equal(buildTriagePatch({ ai_confidence: -0.1 }, {}).ai_confidence, null);
  });

  it('rejects non-number types (string, null, missing)', () => {
    assert.equal(buildTriagePatch({ ai_confidence: '0.85' }, {}).ai_confidence, null);
    assert.equal(buildTriagePatch({ ai_confidence: null }, {}).ai_confidence, null);
    assert.equal(buildTriagePatch({}, {}).ai_confidence, null);
  });
});

describe('buildTriagePatch — array fields', () => {
  it('passes through arrays for non_clinical_items', () => {
    const patch = buildTriagePatch({ non_clinical_items: ['shipping', 'billing'] }, {});
    assert.equal(patch.non_clinical_items.length, 2);
    assert.equal(patch.non_clinical_items[0], 'shipping');
    assert.equal(patch.non_clinical_items[1], 'billing');
  });

  it('passes through arrays for follow_up_questions', () => {
    const patch = buildTriagePatch({ follow_up_questions: ['When did it start?'] }, {});
    assert.equal(patch.follow_up_questions.length, 1);
    assert.equal(patch.follow_up_questions[0], 'When did it start?');
  });

  it('defaults non_clinical_items to empty array when missing', () => {
    assert.equal(buildTriagePatch({}, {}).non_clinical_items.length, 0);
  });

  it('defaults follow_up_questions to empty array when missing', () => {
    assert.equal(buildTriagePatch({}, {}).follow_up_questions.length, 0);
  });

  it('coerces non-array values to empty array', () => {
    assert.equal(buildTriagePatch({ non_clinical_items: 'shipping' }, {}).non_clinical_items.length, 0);
    assert.equal(buildTriagePatch({ follow_up_questions: null }, {}).follow_up_questions.length, 0);
  });

  it('coerces non_clinical_flag to boolean', () => {
    assert.equal(buildTriagePatch({ non_clinical_flag: true }, {}).non_clinical_flag, true);
    assert.equal(buildTriagePatch({ non_clinical_flag: false }, {}).non_clinical_flag, false);
    assert.equal(buildTriagePatch({}, {}).non_clinical_flag, false);
    // Truthy non-bool coerces to true.
    assert.equal(buildTriagePatch({ non_clinical_flag: 1 }, {}).non_clinical_flag, true);
  });
});

describe('buildTriagePatch — telemetry mapping', () => {
  it('maps Anthropic usage fields to telemetry columns', () => {
    const patch = buildTriagePatch({}, {
      model: 'claude-haiku-4-5',
      latency_ms: 1234,
      cost_usd: 0.0015,
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    });
    assert.equal(patch.model, 'claude-haiku-4-5');
    assert.equal(patch.latency_ms, 1234);
    assert.equal(patch.cost_usd, 0.0015);
    assert.equal(patch.input_tokens, 500);
    assert.equal(patch.output_tokens, 100);
    assert.equal(patch.cache_creation_tokens, 200);
    assert.equal(patch.cache_read_tokens, 300);
  });

  it('defaults telemetry fields to null when relai or usage is missing', () => {
    const patch = buildTriagePatch({}, {});
    assert.equal(patch.model, null);
    assert.equal(patch.latency_ms, null);
    assert.equal(patch.cost_usd, null);
    assert.equal(patch.input_tokens, null);
    assert.equal(patch.output_tokens, null);
    assert.equal(patch.cache_creation_tokens, null);
    assert.equal(patch.cache_read_tokens, null);
  });

  it('preserves zero values for token counts (not coerced to null)', () => {
    const patch = buildTriagePatch({}, {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    assert.equal(patch.input_tokens, 0);
    assert.equal(patch.output_tokens, 0);
    assert.equal(patch.cache_creation_tokens, 0);
    assert.equal(patch.cache_read_tokens, 0);
  });

  it('preserves zero latency / cost', () => {
    const patch = buildTriagePatch({}, { latency_ms: 0, cost_usd: 0 });
    assert.equal(patch.latency_ms, 0);
    assert.equal(patch.cost_usd, 0);
  });
});

describe('buildTriagePatch — null safety', () => {
  it('handles null inputs without throwing', () => {
    const patch = buildTriagePatch(null, null);
    assert.equal(typeof patch, 'object');
    assert.equal(patch.status, 'triaged');
    assert.equal(patch.clinical_routing_level, 'none');
  });

  it('handles undefined inputs without throwing', () => {
    const patch = buildTriagePatch(undefined, undefined);
    assert.equal(typeof patch, 'object');
    assert.equal(patch.status, 'triaged');
  });
});

// ─────────────────────────────────────────────────────────────────
// Routing Hub override (Phase 3 protocol)
// ─────────────────────────────────────────────────────────────────
//
// When triage succeeded with valid output BUT the AI flagged its
// own confidence as below the review threshold, the task should
// land in the Routing Hub pool for non-clinical staff to
// recategorize. Status stays 'triaged' (the row is valid output);
// the AI's guessed category is preserved as a breadcrumb in
// internal_note.

const { RELAI_DEFAULTS } = require('../data/defaults.js');
const THRESHOLD = RELAI_DEFAULTS.reviewConfidenceThreshold;
const ROUTING_HUB = RELAI_DEFAULTS.routingHubCategory;

describe('buildTriagePatch — Routing Hub override', () => {
  it('overrides clinical_category when ai_confidence is below threshold', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects', ai_confidence: 0.4 },
      {}
    );
    assert.equal(patch.clinical_category, ROUTING_HUB);
    assert.equal(patch.status, 'triaged');  // not reviewed
    assert.equal(patch.ai_confidence, 0.4);
  });

  it('preserves the AI\'s original category in internal_note (breadcrumb)', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects', ai_confidence: 0.4 },
      {}
    );
    assert.ok(/Side Effects/.test(patch.internal_note), 'note should mention original category');
    assert.ok(/Routing Hub/i.test(patch.internal_note), 'note should reference the routing-hub destination');
    assert.ok(/0\.40/.test(patch.internal_note), 'note should include the confidence value');
  });

  it('does NOT override when ai_confidence is at exactly the threshold', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects', ai_confidence: THRESHOLD },
      {}
    );
    assert.equal(patch.clinical_category, 'Side Effects');
  });

  it('does NOT override when ai_confidence is above the threshold', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects', ai_confidence: 0.95 },
      {}
    );
    assert.equal(patch.clinical_category, 'Side Effects');
  });

  it('does NOT override when ai_confidence is null/missing', () => {
    // No confidence value means we have no basis to override — leave
    // the AI's category in place.
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects' },
      {}
    );
    assert.equal(patch.clinical_category, 'Side Effects');
  });

  it('does NOT override when status is reviewed (safety pipeline already escalated)', () => {
    // 'reviewed' rows are in the safety-pipeline path; they take
    // precedence over confidence routing.
    const patch = buildTriagePatch(
      { urgency: 'routine', clinical_category: 'Side Effects', ai_confidence: 0.4 },
      { route_to_human_review: true, route_reason: 'tripwire' }
    );
    assert.equal(patch.status, 'reviewed');
    assert.equal(patch.clinical_category, 'Side Effects');  // not Routing Hub
  });

  it('appends to an existing internal_note rather than overwriting', () => {
    const patch = buildTriagePatch(
      {
        urgency: 'routine',
        clinical_category: 'Side Effects',
        ai_confidence: 0.4,
        internal_note: 'Original AI note for support team.',
      },
      {}
    );
    assert.ok(/Original AI note/.test(patch.internal_note), 'preserves original note');
    assert.ok(/Routing Hub/.test(patch.internal_note), 'appends routing-hub explanation');
  });

  it('handles missing original category gracefully', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine', ai_confidence: 0.3 },  // no clinical_category
      {}
    );
    assert.equal(patch.clinical_category, ROUTING_HUB);
    assert.ok(/uncategorized/i.test(patch.internal_note));
  });
});

// ─────────────────────────────────────────────────────────────────
// Reviewed-row breadcrumb
// ─────────────────────────────────────────────────────────────────
//
// When the safety pipeline forces 'reviewed' status (parse_failed,
// validation_failed, tripwire, haiku_disagree), the AI's output is
// often empty. Without a breadcrumb, a staffer opening the row sees
// blank fields and has to grep audit_log to learn what happened.

describe('buildTriagePatch — reviewed-row breadcrumb', () => {
  it('populates internal_note with route_reason on parse_failed', () => {
    const patch = buildTriagePatch(
      {},  // no AI output
      { route_to_human_review: true, route_reason: 'parse_failed' }
    );
    assert.equal(patch.status, 'reviewed');
    assert.ok(patch.internal_note, 'internal_note should not be empty');
    assert.ok(/parse_failed/.test(patch.internal_note));
    assert.ok(/audit_log/i.test(patch.internal_note));
  });

  it('populates internal_note with route_reason on validation_failed', () => {
    const patch = buildTriagePatch(
      {},
      { route_to_human_review: true, route_reason: 'validation_failed' }
    );
    assert.ok(/validation_failed/.test(patch.internal_note));
  });

  it('populates internal_note with route_reason on tripwire', () => {
    const patch = buildTriagePatch(
      { urgency: 'urgent', clinical_routing_level: 'severe', draft_response: '[CLINICAL TRIPWIRE]' },
      { route_to_human_review: true, route_reason: 'tripwire' }
    );
    assert.ok(/tripwire/.test(patch.internal_note));
  });

  it('does NOT overwrite an existing AI-generated internal_note', () => {
    const patch = buildTriagePatch(
      { internal_note: 'AI-generated handoff note for support team.' },
      { route_to_human_review: true, route_reason: 'parse_failed' }
    );
    assert.equal(patch.internal_note, 'AI-generated handoff note for support team.');
  });

  it('does NOT add a breadcrumb when status is triaged (only fires on reviewed)', () => {
    const patch = buildTriagePatch(
      { urgency: 'routine' },
      {}  // no route_to_human_review
    );
    assert.equal(patch.status, 'triaged');
    // internal_note may be null when the AI didn't generate one; the
    // breadcrumb only fires on the reviewed path.
    assert.equal(patch.internal_note, null);
  });

  it('does NOT add a breadcrumb when route_reason is missing (defensive)', () => {
    const patch = buildTriagePatch(
      {},
      { route_to_human_review: true }  // route_reason omitted
    );
    assert.equal(patch.status, 'reviewed');
    assert.equal(patch.internal_note, null);
  });
});
