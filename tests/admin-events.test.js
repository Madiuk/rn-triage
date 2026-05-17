// tests/admin-events.test.js
//
// Unit tests for the pure helpers in
// netlify/functions/_lib/routes/admin-events.js. The handlers
// themselves orchestrate fetch() against Supabase REST and are
// integration-tested via real deploys (same convention as the
// other route modules). This file pins:
//   - parseLimit  query-string bounds
//   - parseOffset query-string bounds + sanity cap
//   - parseSince  ISO-8601 format gate + Date round-trip
//   - constants   shape / membership

const {
  parseLimit,
  parseOffset,
  parseSince,
  ERROR_EVENT_TYPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
} = require('../netlify/functions/_lib/routes/admin-events.js');

// Helper: shape a minimal "Netlify event" with query-string params.
function makeEvent(params) {
  return { queryStringParameters: params || {} };
}

// ─────────────────────────────────────────────────────────────────
// parseLimit
// ─────────────────────────────────────────────────────────────────

describe('parseLimit', () => {
  it('returns DEFAULT_LIMIT when missing', () => {
    assert.equal(parseLimit(makeEvent({})), DEFAULT_LIMIT);
    assert.equal(parseLimit(makeEvent({ limit: undefined })), DEFAULT_LIMIT);
  });

  it('accepts a valid positive integer', () => {
    assert.equal(parseLimit(makeEvent({ limit: '25' })), 25);
    assert.equal(parseLimit(makeEvent({ limit: '1' })), 1);
  });

  it('caps at MAX_LIMIT for over-large values', () => {
    assert.equal(parseLimit(makeEvent({ limit: '99999' })), MAX_LIMIT);
    assert.equal(parseLimit(makeEvent({ limit: String(MAX_LIMIT + 1) })), MAX_LIMIT);
  });

  it('returns DEFAULT_LIMIT for zero / negative / non-numeric input', () => {
    assert.equal(parseLimit(makeEvent({ limit: '0' })), DEFAULT_LIMIT);
    assert.equal(parseLimit(makeEvent({ limit: '-5' })), DEFAULT_LIMIT);
    assert.equal(parseLimit(makeEvent({ limit: 'abc' })), DEFAULT_LIMIT);
    assert.equal(parseLimit(makeEvent({ limit: '' })), DEFAULT_LIMIT);
  });

  it('does not throw on missing event / missing queryStringParameters', () => {
    assert.equal(parseLimit(null), DEFAULT_LIMIT);
    assert.equal(parseLimit({}), DEFAULT_LIMIT);
    assert.equal(parseLimit({ queryStringParameters: null }), DEFAULT_LIMIT);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseOffset
// ─────────────────────────────────────────────────────────────────

describe('parseOffset', () => {
  it('returns 0 when missing', () => {
    assert.equal(parseOffset(makeEvent({})), 0);
  });

  it('accepts a valid non-negative integer', () => {
    assert.equal(parseOffset(makeEvent({ offset: '50' })), 50);
    assert.equal(parseOffset(makeEvent({ offset: '500' })), 500);
  });

  it('treats 0 explicitly as 0 (not coerced to default)', () => {
    assert.equal(parseOffset(makeEvent({ offset: '0' })), 0);
  });

  it('caps at MAX_OFFSET', () => {
    assert.equal(parseOffset(makeEvent({ offset: '99999999' })), MAX_OFFSET);
  });

  it('returns 0 for negative / non-numeric / empty', () => {
    assert.equal(parseOffset(makeEvent({ offset: '-1' })), 0);
    assert.equal(parseOffset(makeEvent({ offset: 'abc' })), 0);
    assert.equal(parseOffset(makeEvent({ offset: '' })), 0);
  });

  it('safe on missing event', () => {
    assert.equal(parseOffset(null), 0);
    assert.equal(parseOffset({}), 0);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseSince — ISO-8601 gate
// ─────────────────────────────────────────────────────────────────

describe('parseSince', () => {
  it('returns null when missing / empty', () => {
    assert.equal(parseSince(makeEvent({})), null);
    assert.equal(parseSince(makeEvent({ since: '' })), null);
  });

  it('accepts a full UTC ISO timestamp and returns canonical form', () => {
    const out = parseSince(makeEvent({ since: '2026-05-17T15:30:00Z' }));
    assert.ok(out);
    assert.equal(out, '2026-05-17T15:30:00.000Z');
  });

  it('accepts a date-only string', () => {
    const out = parseSince(makeEvent({ since: '2026-05-17' }));
    assert.ok(out);
    // Round-trips to start-of-day UTC
    assert.equal(out, '2026-05-17T00:00:00.000Z');
  });

  it('accepts ISO with timezone offset', () => {
    const out = parseSince(makeEvent({ since: '2026-05-17T10:00:00-05:00' }));
    assert.ok(out);
    // 10:00 in -05:00 == 15:00 UTC
    assert.equal(out, '2026-05-17T15:00:00.000Z');
  });

  it('accepts ISO with milliseconds', () => {
    const out = parseSince(makeEvent({ since: '2026-05-17T15:30:45.123Z' }));
    assert.equal(out, '2026-05-17T15:30:45.123Z');
  });

  it('rejects non-ISO formats (potential injection vectors)', () => {
    assert.equal(parseSince(makeEvent({ since: '5/17/2026' })), null);
    assert.equal(parseSince(makeEvent({ since: 'yesterday' })), null);
    assert.equal(parseSince(makeEvent({ since: '2026/05/17' })), null);
    assert.equal(parseSince(makeEvent({ since: "2026-05-17' OR 1=1--" })), null);
  });

  it('rejects partial / malformed ISO strings (year-only, year-month, junk)', () => {
    // These fail the regex gate, never reach `new Date()`.
    assert.equal(parseSince(makeEvent({ since: '2026' })), null);
    assert.equal(parseSince(makeEvent({ since: '2026-05' })), null);
    assert.equal(parseSince(makeEvent({ since: 'not-a-date' })), null);
    assert.equal(parseSince(makeEvent({ since: '26-05-17' })), null);  // 2-digit year
  });

  it('rejects non-string input', () => {
    assert.equal(parseSince(makeEvent({ since: 12345 })), null);
    assert.equal(parseSince(makeEvent({ since: null })), null);
  });

  it('safe on missing event', () => {
    assert.equal(parseSince(null), null);
    assert.equal(parseSince({}), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

describe('admin-events module constants', () => {
  it('DEFAULT_LIMIT is a sensible page size', () => {
    assert.equal(typeof DEFAULT_LIMIT, 'number');
    assert.ok(DEFAULT_LIMIT > 0);
    assert.ok(DEFAULT_LIMIT <= MAX_LIMIT);
  });

  it('MAX_LIMIT > DEFAULT_LIMIT and is finite', () => {
    assert.ok(MAX_LIMIT > DEFAULT_LIMIT);
    assert.ok(Number.isFinite(MAX_LIMIT));
  });

  it('MAX_OFFSET is a large but finite cap', () => {
    assert.ok(MAX_OFFSET > 100);
    assert.ok(Number.isFinite(MAX_OFFSET));
  });

  it('ERROR_EVENT_TYPES contains the known failure types', () => {
    assert.ok(Array.isArray(ERROR_EVENT_TYPES));
    assert.ok(ERROR_EVENT_TYPES.length > 0);
    // Sanity: documented failure events from worker.js + queue.js.
    assert.ok(ERROR_EVENT_TYPES.indexOf('triage.failed') !== -1);
    assert.ok(ERROR_EVENT_TYPES.indexOf('triage.patch_failed') !== -1);
    assert.ok(ERROR_EVENT_TYPES.indexOf('queue.send.db_failure') !== -1);
  });

  it('ERROR_EVENT_TYPES entries are all non-empty strings', () => {
    ERROR_EVENT_TYPES.forEach(t => {
      assert.equal(typeof t, 'string');
      assert.ok(t.length > 0);
    });
  });
});
