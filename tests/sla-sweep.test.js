const {
  SLA_24H_MS,
  SLA_8H_MS,
  isExpired24h,
  isExpired8h,
  build24hSweepPatch,
  build8hSweepPatch,
} = require('../netlify/functions/sla-sweep.js');

describe('SLA constants', () => {
  it('SLA_24H_MS equals 24 hours in ms', () => {
    assert.equal(SLA_24H_MS, 24 * 60 * 60 * 1000);
    assert.equal(SLA_24H_MS, 86400000);
  });

  it('SLA_8H_MS equals 8 hours in ms', () => {
    assert.equal(SLA_8H_MS, 8 * 60 * 60 * 1000);
    assert.equal(SLA_8H_MS, 28800000);
  });
});

describe('isExpired24h — boundary behavior', () => {
  const now = new Date('2026-05-16T12:00:00Z').getTime();

  it('returns false at exactly 24h elapsed (SQL `lt` is strict)', () => {
    const firstPulledAt = new Date(now - SLA_24H_MS).toISOString();
    assert.equal(isExpired24h(firstPulledAt, now), false);
  });

  it('returns true at 24h + 1ms elapsed', () => {
    const firstPulledAt = new Date(now - SLA_24H_MS - 1).toISOString();
    assert.equal(isExpired24h(firstPulledAt, now), true);
  });

  it('returns false at 24h - 1ms elapsed', () => {
    const firstPulledAt = new Date(now - SLA_24H_MS + 1).toISOString();
    assert.equal(isExpired24h(firstPulledAt, now), false);
  });

  it('returns true when 25h elapsed', () => {
    const firstPulledAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    assert.equal(isExpired24h(firstPulledAt, now), true);
  });

  it('returns false when 1h elapsed', () => {
    const firstPulledAt = new Date(now - 60 * 60 * 1000).toISOString();
    assert.equal(isExpired24h(firstPulledAt, now), false);
  });
});

describe('isExpired24h — input handling', () => {
  const now = Date.now();

  it('accepts ISO string', () => {
    const past = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    assert.equal(isExpired24h(past, now), true);
  });

  it('accepts Unix timestamp (number)', () => {
    const past = now - 25 * 60 * 60 * 1000;
    assert.equal(isExpired24h(past, now), true);
  });

  it('returns false for null', () => {
    assert.equal(isExpired24h(null, now), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isExpired24h(undefined, now), false);
  });

  it('returns false for invalid date strings', () => {
    assert.equal(isExpired24h('not a date', now), false);
    assert.equal(isExpired24h('', now), false);
  });
});

describe('isExpired8h — boundary behavior', () => {
  const now = new Date('2026-05-16T12:00:00Z').getTime();

  it('returns false at exactly 8h elapsed', () => {
    const lastReply = new Date(now - SLA_8H_MS).toISOString();
    assert.equal(isExpired8h(lastReply, now), false);
  });

  it('returns true at 8h + 1ms elapsed', () => {
    const lastReply = new Date(now - SLA_8H_MS - 1).toISOString();
    assert.equal(isExpired8h(lastReply, now), true);
  });

  it('returns false at 7h elapsed', () => {
    const lastReply = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    assert.equal(isExpired8h(lastReply, now), false);
  });

  it('returns true at 9h elapsed', () => {
    const lastReply = new Date(now - 9 * 60 * 60 * 1000).toISOString();
    assert.equal(isExpired8h(lastReply, now), true);
  });

  it('returns false for null / undefined / invalid', () => {
    assert.equal(isExpired8h(null, now), false);
    assert.equal(isExpired8h(undefined, now), false);
    assert.equal(isExpired8h('garbage', now), false);
  });
});

describe('build24hSweepPatch', () => {
  it('sets due_state to true', () => {
    assert.equal(build24hSweepPatch().due_state, true);
  });

  it('releases the claim (claimed_by + claimed_at null)', () => {
    const patch = build24hSweepPatch();
    assert.equal(patch.claimed_by, null);
    assert.equal(patch.claimed_at, null);
  });

  it('does not touch last_patient_reply_at', () => {
    const patch = build24hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'last_patient_reply_at'), false);
  });

  it('does not touch status (24h SLA releases claim but does not close the task)', () => {
    const patch = build24hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'status'), false);
  });

  it('does not touch first_pulled_at (immutable anchor)', () => {
    const patch = build24hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'first_pulled_at'), false);
  });
});

describe('build8hSweepPatch', () => {
  it('sets due_state to true', () => {
    assert.equal(build8hSweepPatch().due_state, true);
  });

  it('clears last_patient_reply_at so the sweep does not refire', () => {
    assert.equal(build8hSweepPatch().last_patient_reply_at, null);
  });

  it('preserves the claim (does not release claimed_by/claimed_at)', () => {
    const patch = build8hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'claimed_by'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'claimed_at'), false);
  });

  it('does not touch status', () => {
    const patch = build8hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'status'), false);
  });

  it('does not touch first_pulled_at', () => {
    const patch = build8hSweepPatch();
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'first_pulled_at'), false);
  });
});
