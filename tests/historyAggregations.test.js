const {
  aggregateCostRows,
  aggregateQualityRows,
} = require('../netlify/functions/_lib/history-aggregations.js');

describe('aggregateCostRows', () => {
  it('returns zero/empty shape on empty input', () => {
    const r = aggregateCostRows([]);
    assert.equal(r.total_cost_usd, 0);
    assert.equal(r.total_triages, 0);
    assert.equal(r.mean_cost_per_triage, 0);
    assert.equal(r.mean_latency_ms, null);
    assert.equal(r.cache_hit_rate, 0);
    assert.deepEqual(r.by_day, []);
    assert.deepEqual(r.by_model, []);
  });

  it('sums cost and counts rows', () => {
    const rows = [
      { created_at: '2026-05-08T10:00:00Z', model: 'claude-sonnet-4-6', cost_usd: 0.014, latency_ms: 6500,
        input_tokens: 500, output_tokens: 800, cache_read_tokens: 3000, cache_creation_tokens: 0 },
      { created_at: '2026-05-08T11:00:00Z', model: 'claude-sonnet-4-6', cost_usd: 0.012, latency_ms: 5500,
        input_tokens: 400, output_tokens: 700, cache_read_tokens: 3000, cache_creation_tokens: 0 },
    ];
    const r = aggregateCostRows(rows);
    assert.equal(r.total_cost_usd, 0.026);
    assert.equal(r.total_triages, 2);
    assert.equal(r.mean_latency_ms, 6000);
    assert.equal(r.tokens.fresh_input, 900);
    assert.equal(r.tokens.cache_read, 6000);
    assert.equal(r.tokens.output, 1500);
  });

  it('computes cache hit rate from input-token mix', () => {
    // 1000 fresh + 9000 cache_read = 90% cache hit on input.
    const rows = [{
      created_at: '2026-05-08T10:00:00Z', model: 'claude-sonnet-4-6', cost_usd: 0.01,
      input_tokens: 1000, cache_read_tokens: 9000, cache_creation_tokens: 0, output_tokens: 500,
    }];
    const r = aggregateCostRows(rows);
    assert.equal(r.cache_hit_rate, 0.9);
  });

  it('groups by day and by model', () => {
    const rows = [
      { created_at: '2026-05-08T10:00:00Z', model: 'claude-sonnet-4-6', cost_usd: 0.01 },
      { created_at: '2026-05-08T11:00:00Z', model: 'claude-haiku-4-5',  cost_usd: 0.001 },
      { created_at: '2026-05-09T09:00:00Z', model: 'claude-sonnet-4-6', cost_usd: 0.02 },
    ];
    const r = aggregateCostRows(rows);

    // by_day sorted ascending
    assert.equal(r.by_day.length, 2);
    assert.equal(r.by_day[0].day, '2026-05-08');
    assert.equal(r.by_day[0].count, 2);
    assert.equal(r.by_day[1].day, '2026-05-09');
    assert.equal(r.by_day[1].count, 1);

    // by_model sorted by cost descending — sonnet first
    assert.equal(r.by_model[0].model, 'claude-sonnet-4-6');
    assert.equal(r.by_model[0].count, 2);
    assert.equal(r.by_model[1].model, 'claude-haiku-4-5');
  });

  it('tolerates rows missing observability columns', () => {
    // Older rows from before migration 0005 have no model/tokens/cost.
    // Aggregation must not crash and must treat them as 0 cost.
    const rows = [
      { created_at: '2026-05-01T10:00:00Z' },
      { created_at: '2026-05-01T11:00:00Z', cost_usd: 0.01, model: 'claude-sonnet-4-6' },
    ];
    const r = aggregateCostRows(rows);
    assert.equal(r.total_triages, 2);
    assert.equal(r.total_cost_usd, 0.01);
    // The unstamped row goes into the 'unknown' model bucket.
    const unknownBucket = r.by_model.find(m => m.model === 'unknown');
    assert.ok(unknownBucket, 'expected an "unknown" model bucket');
    assert.equal(unknownBucket.count, 1);
  });
});

describe('aggregateQualityRows', () => {
  it('returns zero rates on empty input', () => {
    const r = aggregateQualityRows([]);
    assert.equal(r.total_triages, 0);
    assert.equal(r.urgency_override_rate, 0);
    assert.equal(r.correction_rate, 0);
    assert.equal(r.mean_edit_distance, null);
    assert.equal(r.mean_ai_confidence, null);
    assert.deepEqual(r.by_prompt_version, []);
  });

  it('counts a row as overridden only when override differs from original', () => {
    // Same value in both columns means staff confirmed the AI; should
    // NOT count as an override.
    const rows = [
      { urgency_original: 'urgent', urgency_override: 'urgent' },
      { urgency_original: 'routine', urgency_override: 'urgent' },
      { urgency_original: 'routine', urgency_override: null },
    ];
    const r = aggregateQualityRows(rows);
    assert.equal(r.urgency_override_rate, 1 / 3);
  });

  it('treats either actual_response_sent or correction_note as a correction', () => {
    const rows = [
      { actual_response_sent: 'edited reply' },
      { correction_note: 'changed wording' },
      { actual_response_sent: null, correction_note: null },
    ];
    const r = aggregateQualityRows(rows);
    assert.equal(r.correction_rate, 2 / 3);
  });

  it('averages ai_confidence and edit_distance, ignoring nulls', () => {
    const rows = [
      { ai_confidence: 0.9,  edit_distance: 0   },
      { ai_confidence: 0.7,  edit_distance: 100 },
      { ai_confidence: null, edit_distance: null }, // dropped from both averages
    ];
    const r = aggregateQualityRows(rows);
    assert.equal(r.mean_ai_confidence, 0.8);
    assert.equal(r.mean_edit_distance, 50);
  });

  it('groups by prompt_version with per-version override + correction rates', () => {
    const rows = [
      { prompt_version: 'aaaa1111', urgency_original: 'routine', urgency_override: 'urgent', actual_response_sent: 'x' },
      { prompt_version: 'aaaa1111', urgency_original: 'routine', urgency_override: null,     actual_response_sent: null },
      { prompt_version: 'bbbb2222', urgency_original: 'routine', urgency_override: null,     actual_response_sent: null },
    ];
    const r = aggregateQualityRows(rows);
    assert.equal(r.by_prompt_version.length, 2);
    // Sorted by count desc
    assert.equal(r.by_prompt_version[0].prompt_version, 'aaaa1111');
    assert.equal(r.by_prompt_version[0].count, 2);
    assert.equal(r.by_prompt_version[0].urgency_override_rate, 0.5);
    assert.equal(r.by_prompt_version[0].correction_rate, 0.5);
    assert.equal(r.by_prompt_version[1].prompt_version, 'bbbb2222');
    assert.equal(r.by_prompt_version[1].count, 1);
  });

  it('buckets unstamped rows under "unstamped"', () => {
    const rows = [
      { },
      { prompt_version: null },
    ];
    const r = aggregateQualityRows(rows);
    assert.equal(r.by_prompt_version.length, 1);
    assert.equal(r.by_prompt_version[0].prompt_version, 'unstamped');
    assert.equal(r.by_prompt_version[0].count, 2);
  });
});
