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
  bucketConfidence,
  aggregateCalibration,
  aggregateReassignments,
  aggregateCloseNoReply,
  ERROR_EVENT_TYPES,
  CONFIDENCE_BUCKETS,
  TERMINAL_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
  LEARNING_ROW_CAP,
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

  it('CONFIDENCE_BUCKETS contains all four expected bands', () => {
    assert.ok(Array.isArray(CONFIDENCE_BUCKETS));
    assert.deepEqual(
      CONFIDENCE_BUCKETS.slice().sort(),
      ['certain', 'low', 'medium', 'unknown']
    );
  });

  it('TERMINAL_STATUSES matches the status CHECK in migration 0027', () => {
    // sent / closed / completed / closed_no_reply are the four
    // "finished" outcomes. open statuses must NOT appear here.
    assert.ok(TERMINAL_STATUSES.indexOf('sent') !== -1);
    assert.ok(TERMINAL_STATUSES.indexOf('closed_no_reply') !== -1);
    assert.ok(TERMINAL_STATUSES.indexOf('pending') === -1);
    assert.ok(TERMINAL_STATUSES.indexOf('triaged') === -1);
    assert.ok(TERMINAL_STATUSES.indexOf('pending_parent') === -1);
  });

  it('LEARNING_ROW_CAP is a sensible large-but-finite cap', () => {
    assert.equal(typeof LEARNING_ROW_CAP, 'number');
    assert.ok(LEARNING_ROW_CAP >= 1000);
    assert.ok(Number.isFinite(LEARNING_ROW_CAP));
  });
});

// ─────────────────────────────────────────────────────────────────
// bucketConfidence — band boundaries
// ─────────────────────────────────────────────────────────────────

describe('bucketConfidence', () => {
  it('returns low for values strictly < 0.70', () => {
    assert.equal(bucketConfidence(0.00), 'low');
    assert.equal(bucketConfidence(0.50), 'low');
    assert.equal(bucketConfidence(0.69), 'low');
    assert.equal(bucketConfidence(0.6999999), 'low');
  });

  it('returns medium for [0.70, 1.00)', () => {
    assert.equal(bucketConfidence(0.70), 'medium');
    assert.equal(bucketConfidence(0.85), 'medium');
    assert.equal(bucketConfidence(0.99), 'medium');
    assert.equal(bucketConfidence(0.9999999), 'medium');
  });

  it('returns certain only for exactly 1.00', () => {
    assert.equal(bucketConfidence(1.00), 'certain');
    assert.equal(bucketConfidence(1), 'certain');
  });

  it('returns unknown for null / undefined / NaN / non-numeric', () => {
    assert.equal(bucketConfidence(null), 'unknown');
    assert.equal(bucketConfidence(undefined), 'unknown');
    assert.equal(bucketConfidence(NaN), 'unknown');
    assert.equal(bucketConfidence('abc'), 'unknown');
  });

  it('coerces numeric strings (PostgREST returns numeric as string)', () => {
    assert.equal(bucketConfidence('0.5'), 'low');
    assert.equal(bucketConfidence('0.85'), 'medium');
    assert.equal(bucketConfidence('1.00'), 'certain');
    assert.equal(bucketConfidence('1'), 'certain');
  });
});

// ─────────────────────────────────────────────────────────────────
// aggregateCalibration
// ─────────────────────────────────────────────────────────────────

describe('aggregateCalibration', () => {
  it('empty input returns zero-initialised buckets', () => {
    const out = aggregateCalibration([]);
    for (const b of CONFIDENCE_BUCKETS) {
      assert.equal(out[b].n_total, 0);
      assert.equal(out[b].n_terminal, 0);
      assert.equal(out[b].urgency_changed, 0);
      assert.equal(out[b].category_reassigned, 0);
      assert.equal(out[b].closed_no_reply, 0);
    }
  });

  it('safe on null / undefined input', () => {
    const out = aggregateCalibration(null);
    assert.equal(out.certain.n_total, 0);
  });

  it('counts a single certain-bucket row (no overrides)', () => {
    const out = aggregateCalibration([{
      ai_confidence: 1.0, urgency_original: 3, urgency_override: 3,
      status: 'sent', task_reassignments: [],
    }]);
    assert.equal(out.certain.n_total, 1);
    assert.equal(out.certain.n_terminal, 1);
    assert.equal(out.certain.urgency_changed, 0);
    assert.equal(out.certain.category_reassigned, 0);
    assert.equal(out.certain.closed_no_reply, 0);
  });

  it('flags urgency_changed only when both fields set AND differ', () => {
    const out = aggregateCalibration([
      { ai_confidence: 1.0, urgency_original: 3, urgency_override: 5, status: 'sent' },
      { ai_confidence: 1.0, urgency_original: 3, urgency_override: 3, status: 'sent' },
      { ai_confidence: 1.0, urgency_original: 3, urgency_override: null, status: 'sent' },
      { ai_confidence: 1.0, urgency_original: null, urgency_override: 5, status: 'sent' },
    ]);
    assert.equal(out.certain.urgency_changed, 1);
  });

  it('flags category_reassigned when task_reassignments has entries', () => {
    const out = aggregateCalibration([
      { ai_confidence: 1.0, status: 'sent', task_reassignments: [{ id: 'r1' }] },
      { ai_confidence: 1.0, status: 'sent', task_reassignments: [{ id: 'r2' }, { id: 'r3' }] },
      { ai_confidence: 1.0, status: 'sent', task_reassignments: [] },
      { ai_confidence: 1.0, status: 'sent', task_reassignments: null },
      { ai_confidence: 1.0, status: 'sent' },  // missing field
    ]);
    assert.equal(out.certain.category_reassigned, 2);
  });

  it('n_terminal counts only TERMINAL_STATUSES; closed_no_reply is a subset', () => {
    const out = aggregateCalibration([
      { ai_confidence: 1.0, status: 'pending' },
      { ai_confidence: 1.0, status: 'triaged' },
      { ai_confidence: 1.0, status: 'reviewed' },
      { ai_confidence: 1.0, status: 'pending_parent' },
      { ai_confidence: 1.0, status: 'sent' },
      { ai_confidence: 1.0, status: 'closed' },
      { ai_confidence: 1.0, status: 'completed' },
      { ai_confidence: 1.0, status: 'closed_no_reply' },
    ]);
    assert.equal(out.certain.n_total, 8);
    assert.equal(out.certain.n_terminal, 4);
    assert.equal(out.certain.closed_no_reply, 1);
  });

  it('routes rows to the right bucket', () => {
    const out = aggregateCalibration([
      { ai_confidence: 0.50, status: 'sent' },  // low
      { ai_confidence: 0.85, status: 'sent' },  // medium
      { ai_confidence: 1.00, status: 'sent' },  // certain
      { ai_confidence: null, status: 'sent' },  // unknown
    ]);
    assert.equal(out.low.n_total, 1);
    assert.equal(out.medium.n_total, 1);
    assert.equal(out.certain.n_total, 1);
    assert.equal(out.unknown.n_total, 1);
  });
});

// ─────────────────────────────────────────────────────────────────
// aggregateReassignments
// ─────────────────────────────────────────────────────────────────

describe('aggregateReassignments', () => {
  it('empty / null input returns empty array', () => {
    assert.deepEqual(aggregateReassignments([]), []);
    assert.deepEqual(aggregateReassignments(null), []);
    assert.deepEqual(aggregateReassignments(undefined), []);
  });

  it('groups by (from, to) pair and counts occurrences', () => {
    const out = aggregateReassignments([
      { from_category: 'billing',  to_category: 'clinical' },
      { from_category: 'billing',  to_category: 'clinical' },
      { from_category: 'clinical', to_category: 'admin' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { from: 'billing', to: 'clinical', n: 2 });
    assert.deepEqual(out[1], { from: 'clinical', to: 'admin', n: 1 });
  });

  it('sorts by descending n so most-common mis-routes appear first', () => {
    const out = aggregateReassignments([
      { from_category: 'a', to_category: 'b' },
      { from_category: 'c', to_category: 'd' }, { from_category: 'c', to_category: 'd' },
      { from_category: 'c', to_category: 'd' }, { from_category: 'c', to_category: 'd' },
      { from_category: 'e', to_category: 'f' }, { from_category: 'e', to_category: 'f' },
    ]);
    assert.equal(out[0].n, 4);
    assert.equal(out[1].n, 2);
    assert.equal(out[2].n, 1);
  });

  it('renders null category as the literal "(null)" so it groups distinctly', () => {
    const out = aggregateReassignments([
      { from_category: null, to_category: 'clinical' },
      { from_category: null, to_category: 'clinical' },
    ]);
    assert.equal(out[0].from, '(null)');
    assert.equal(out[0].n, 2);
  });
});

// ─────────────────────────────────────────────────────────────────
// aggregateCloseNoReply
// ─────────────────────────────────────────────────────────────────

describe('aggregateCloseNoReply', () => {
  it('empty / null input returns empty array', () => {
    assert.deepEqual(aggregateCloseNoReply([]), []);
    assert.deepEqual(aggregateCloseNoReply(null), []);
  });

  it('skips non-terminal rows from both numerator and denominator', () => {
    const out = aggregateCloseNoReply([
      { status: 'pending',         clinical_category: 'billing' },
      { status: 'triaged',         clinical_category: 'billing' },
      { status: 'sent',            clinical_category: 'billing' },
      { status: 'closed_no_reply', clinical_category: 'billing' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'billing');
    assert.equal(out[0].n_terminal, 2);
    assert.equal(out[0].closed_no_reply, 1);
  });

  it('groups by clinical_category and sorts by n_terminal desc', () => {
    const out = aggregateCloseNoReply([
      { status: 'sent', clinical_category: 'a' },
      { status: 'sent', clinical_category: 'b' },
      { status: 'sent', clinical_category: 'b' },
      { status: 'sent', clinical_category: 'b' },
    ]);
    assert.equal(out[0].category, 'b');
    assert.equal(out[0].n_terminal, 3);
    assert.equal(out[1].category, 'a');
    assert.equal(out[1].n_terminal, 1);
  });

  it('renders null clinical_category as "(uncategorized)"', () => {
    const out = aggregateCloseNoReply([
      { status: 'sent', clinical_category: null },
    ]);
    assert.equal(out[0].category, '(uncategorized)');
  });
});

// ─────────────────────────────────────────────────────────────────
// Route-level tests — handle(/admin/events/learning)
// ─────────────────────────────────────────────────────────────────
//
// First route-level test in this codebase. Pattern (see tests/run.js
// for why this is safe to do here): the runner serialises tests, so
// each test snapshots require.cache + global.fetch up front, installs
// stubs, busts admin-events from cache so it re-resolves with the
// stubs, and unconditionally restores in finally{}. Subsequent tests
// see a clean slate.
//
// We stub auth.js, permissions.js, and global.fetch. We do NOT stub
// supabase.js — its URL builder is harmless when fetch is mocked,
// and skipping the stub keeps this test focused on behavior the
// route owns (gate, dispatch, aggregation, response shape).

describe('handle(/admin/events/learning) — route-level', () => {
  const authPath   = require.resolve('../netlify/functions/_lib/auth.js');
  const permsPath  = require.resolve('../netlify/functions/_lib/permissions.js');
  const eventsPath = require.resolve('../netlify/functions/_lib/routes/admin-events.js');

  function snapshot() {
    return {
      auth:   require.cache[authPath],
      perms:  require.cache[permsPath],
      events: require.cache[eventsPath],
      fetch:  global.fetch,
    };
  }
  function restore(s) {
    if (s.auth)   require.cache[authPath]   = s.auth;   else delete require.cache[authPath];
    if (s.perms)  require.cache[permsPath]  = s.perms;  else delete require.cache[permsPath];
    if (s.events) require.cache[eventsPath] = s.events; else delete require.cache[eventsPath];
    global.fetch = s.fetch;
  }
  function stubModule(filename, exportsObj) {
    require.cache[filename] = {
      id: filename, filename, loaded: true, exports: exportsObj, children: [],
    };
  }
  function ev(opts) {
    opts = opts || {};
    return {
      path: opts.path || '/admin/events/learning',
      httpMethod: opts.method || 'GET',
      headers: opts.headers || { authorization: 'Bearer super-token' },
      queryStringParameters: opts.qs || null,
    };
  }
  // fetch stub returning the supplied bodies. Branches by URL substring
  // because Promise.all dispatch order isn't part of the contract.
  function makeFetchStub(qhBody, trBody, opts) {
    opts = opts || {};
    const calls = [];
    return {
      calls,
      fn: async (url) => {
        calls.push({ url });
        if (url.indexOf('/rest/v1/query_history') !== -1) {
          if (opts.qhFail) return { ok: false, status: opts.qhFail, text: async () => 'qh err' };
          return { ok: true, status: 200, json: async () => qhBody };
        }
        if (url.indexOf('/rest/v1/task_reassignments') !== -1) {
          if (opts.trFail) return { ok: false, status: opts.trFail, text: async () => 'tr err' };
          return { ok: true, status: 200, json: async () => trBody };
        }
        return { ok: false, status: 599, text: async () => 'unexpected URL' };
      },
    };
  }
  const superAuth = {
    verifyUser: async (t) => t === 'super-token' ? { id: 'u1' } : null,
    resolveProfile: async () => ({ id: 'u1', company_id: 'co-1', is_super_user: true }),
    extractToken: (e) => ((e.headers && e.headers.authorization) || '').replace(/^Bearer\s+/, ''),
  };
  const superPerms = { isSuperUser: (p) => !!p.is_super_user };

  it('200 happy path: aggregates rows from two PostgREST fetches', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, superAuth);
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      const fs = makeFetchStub([
        { id: 't1', ai_confidence: 1.0, urgency_original: 3, urgency_override: 5,
          status: 'sent', clinical_category: 'billing', task_reassignments: [] },
        { id: 't2', ai_confidence: 0.5, urgency_original: 2, urgency_override: 2,
          status: 'closed_no_reply', clinical_category: 'clinical',
          task_reassignments: [{ id: 'r1' }] },
      ], [
        { from_category: 'billing', to_category: 'clinical' },
      ]);
      global.fetch = fs.fn;

      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev());
      assert.equal(resp.statusCode, 200);
      const body = JSON.parse(resp.body);
      assert.equal(body.sample_size, 2);
      assert.equal(body.calibration.certain.urgency_changed, 1);
      assert.equal(body.calibration.low.category_reassigned, 1);
      assert.equal(body.calibration.low.closed_no_reply, 1);
      assert.equal(body.reassignment_matrix.length, 1);
      assert.equal(body.reassignment_matrix[0].from, 'billing');
      assert.equal(body.close_no_reply_by_category.length, 2);
      assert.equal(fs.calls.length, 2);
    } finally { restore(snap); }
  });

  it('405 on non-GET', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, superAuth);
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      global.fetch = async () => { throw new Error('should not be called'); };
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev({ method: 'POST' }));
      assert.equal(resp.statusCode, 405);
    } finally { restore(snap); }
  });

  it('401 when token verification fails', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, Object.assign({}, superAuth, { verifyUser: async () => null }));
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      global.fetch = async () => { throw new Error('should not be called'); };
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev({ headers: {} }));
      assert.equal(resp.statusCode, 401);
    } finally { restore(snap); }
  });

  it('403 when caller is authed but not super-user', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, Object.assign({}, superAuth, {
        resolveProfile: async () => ({ id: 'u1', company_id: 'co-1', is_super_user: false }),
      }));
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      global.fetch = async () => { throw new Error('should not be called'); };
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev());
      assert.equal(resp.statusCode, 403);
    } finally { restore(snap); }
  });

  it('400 when super-user has no company_id', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, Object.assign({}, superAuth, {
        resolveProfile: async () => ({ id: 'u1', company_id: null, is_super_user: true }),
      }));
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      global.fetch = async () => { throw new Error('should not be called'); };
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev());
      assert.equal(resp.statusCode, 400);
    } finally { restore(snap); }
  });

  it('passes since= through to both PostgREST URLs', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, superAuth);
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      const fs = makeFetchStub([], []);
      global.fetch = fs.fn;
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev({ qs: { since: '2026-05-01T00:00:00Z' } }));
      assert.equal(resp.statusCode, 200);
      const allHaveSince = fs.calls.every(c => c.url.indexOf('created_at=gte.') !== -1);
      assert.ok(allHaveSince, 'expected both fetch URLs to carry created_at=gte.');
    } finally { restore(snap); }
  });

  it('500 when PostgREST returns a failure on either fetch', async () => {
    const snap = snapshot();
    try {
      stubModule(authPath, superAuth);
      stubModule(permsPath, superPerms);
      delete require.cache[eventsPath];
      const fs = makeFetchStub([], [], { qhFail: 500 });
      global.fetch = fs.fn;
      const { handle } = require('../netlify/functions/_lib/routes/admin-events.js');
      const resp = await handle(ev());
      assert.equal(resp.statusCode, 500);
    } finally { restore(snap); }
  });
});
