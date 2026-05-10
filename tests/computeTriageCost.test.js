const { computeTriageCost, simpleHash, TRIAGE_PRICING } = require('../data/triage-lib.js');

describe('computeTriageCost', () => {
  it('returns null for an unknown model', () => {
    assert.equal(computeTriageCost('made-up-model', { input_tokens: 100, output_tokens: 100 }), null);
  });

  it('returns null when usage is missing', () => {
    assert.equal(computeTriageCost('claude-sonnet-4-6', null), null);
    assert.equal(computeTriageCost('claude-sonnet-4-6', undefined), null);
  });

  it('prices fresh input + output for sonnet correctly', () => {
    // 1M fresh input + 1M output = $3 + $15 = $18
    const r = computeTriageCost('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    assert.equal(r, 18.0);
  });

  it('prices cache reads at the cached rate, not fresh rate', () => {
    // 1M cache_read tokens on sonnet = $0.30, NOT $3.00.
    const r = computeTriageCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    assert.equal(r, 0.30);
  });

  it('prices cache creation at the 5-minute write rate', () => {
    // 1M cache_creation tokens on sonnet = $3.75.
    const r = computeTriageCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    assert.equal(r, 3.75);
  });

  it('combines all four token types additively', () => {
    // Realistic shape: small fresh input, big cache read, small output.
    // 500 fresh + 3000 cache_read + 800 output on sonnet:
    //   fresh:    500    * 3.00 / 1e6 = 0.0015
    //   cache_r:  3000   * 0.30 / 1e6 = 0.0009
    //   output:   800    * 15.00 / 1e6 = 0.012
    //   total = 0.0144
    const r = computeTriageCost('claude-sonnet-4-6', {
      input_tokens: 500,
      output_tokens: 800,
      cache_read_input_tokens: 3000,
    });
    assert.equal(r, 0.0144);
  });

  it('rounds to 6 decimals to match the DB column', () => {
    // 1 fresh input on sonnet would otherwise be 0.000003 — exact, but
    // any later math could produce e.g. 0.0000033333, which would
    // overflow numeric(10,6). Round to 6.
    const r = computeTriageCost('claude-sonnet-4-6', { input_tokens: 1, output_tokens: 0 });
    // Should be exactly 6 decimal digits or fewer.
    const decimals = (String(r).split('.')[1] || '').length;
    assert.ok(decimals <= 6, 'expected <=6 decimals, got ' + decimals + ' (' + r + ')');
  });

  it('haiku is roughly 3x cheaper than sonnet on the same workload', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const sonnet = computeTriageCost('claude-sonnet-4-6', usage);
    const haiku  = computeTriageCost('claude-haiku-4-5',  usage);
    assert.ok(haiku < sonnet, 'haiku should be cheaper than sonnet');
    assert.ok(sonnet / haiku >= 2.5, 'sonnet should be at least 2.5x haiku, got ' + (sonnet / haiku));
  });

  it('exposes a pricing table for every allowed model', () => {
    // Keep the lib pricing table in lockstep with triage.js ALLOWED_MODELS.
    ['claude-sonnet-4-6','claude-haiku-4-5','claude-opus-4-7'].forEach(m => {
      assert.ok(TRIAGE_PRICING[m], 'missing pricing for ' + m);
      ['input','output','cache_write_5m','cache_read'].forEach(k => {
        assert.equal(typeof TRIAGE_PRICING[m][k], 'number', m + '.' + k);
      });
    });
  });
});

describe('simpleHash', () => {
  it('returns 8 hex chars', () => {
    const h = simpleHash('hello');
    assert.equal(h.length, 8);
    assert.match(h, /^[0-9a-f]{8}$/);
  });

  it('is stable for the same input', () => {
    assert.equal(simpleHash('the quick brown fox'), simpleHash('the quick brown fox'));
  });

  it('differs for different inputs', () => {
    assert.notEqual(simpleHash('a'), simpleHash('b'));
    assert.notEqual(simpleHash('prompt v1'), simpleHash('prompt v2'));
  });

  it('handles empty/null/undefined input', () => {
    assert.equal(simpleHash('').length, 8);
    assert.equal(simpleHash(null).length, 8);
    assert.equal(simpleHash(undefined).length, 8);
  });
});
