// tests/queue.test.js
//
// Unit tests for the pure helpers in
// netlify/functions/_lib/routes/queue.js. The handlers themselves
// orchestrate fetch() calls against Supabase; testing those
// directly would require mocking the full REST surface. Instead,
// the protocol decision points (body parsers, capability splitter,
// claim partitioner, precondition checker, priority comparator)
// are exported as pure functions and tested here — matching the
// worker.test.js / sla-sweep.test.js convention.

const {
  inFilter,
  makeTaskPriorityCmp,
  taskPriorityCmp,
  parsePullBody,
  parseRetaskBody,
  parseReassignBody,
  parseSendBody,
  parseVoteBody,
  checkPullPrecondition,
  splitCategoriesByEligibility,
  partitionForClaim,
  dispatchOutbound,
  QUEUE_CAP,
  SEND_TEXT_MAX,
} = require('../netlify/functions/_lib/routes/queue.js');

const { RELAI_DEFAULTS } = require('../data/defaults.js');

// ─────────────────────────────────────────────────────────────────
// inFilter — Supabase REST `in.()` URL building
// ─────────────────────────────────────────────────────────────────

describe('inFilter', () => {
  it('wraps each value in double quotes and joins with comma', () => {
    assert.equal(inFilter(['a', 'b']), '"a","b"');
  });

  it('URL-encodes spaces (e.g. "Routing Hub")', () => {
    assert.equal(inFilter(['Routing Hub']), '"Routing%20Hub"');
  });

  it('URL-encodes slashes (e.g. "Injection/Dosing")', () => {
    // %2F is the encoded form of /. Without encoding the slash
    // would break the Supabase REST query parser.
    assert.ok(inFilter(['Injection/Dosing']).indexOf('%2F') !== -1);
  });

  it('returns empty string for an empty array', () => {
    assert.equal(inFilter([]), '');
  });

  it('coerces non-string values to strings', () => {
    assert.equal(inFilter([42, true]), '"42","true"');
  });

  it('encodes double quotes inside a value (defense)', () => {
    // encodeURIComponent encodes " as %22, preventing the value's
    // own quotes from breaking the wrapping quotes.
    assert.equal(inFilter(['ab"cd']), '"ab%22cd"');
  });
});

// ─────────────────────────────────────────────────────────────────
// makeTaskPriorityCmp / taskPriorityCmp — priority order
// ─────────────────────────────────────────────────────────────────

describe('taskPriorityCmp — severity comes first', () => {
  const cmp = makeTaskPriorityCmp(7);

  it('severe (urgency >= threshold) ranks before non-severe regardless of due_state', () => {
    const severe       = { urgency_score: 7, due_state: false, created_at: '2026-05-16T00:00:00Z' };
    const nonsevereDue = { urgency_score: 6, due_state: true,  created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(severe, nonsevereDue) < 0, true);
  });

  it('within the severe band, Due wins over higher non-Due urgency', () => {
    const dueSevere    = { urgency_score: 8, due_state: true,  created_at: '2026-05-16T00:00:00Z' };
    const nonDueSevere = { urgency_score: 9, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(dueSevere, nonDueSevere) < 0, true);
  });
});

describe('taskPriorityCmp — Due tasks rank ahead of normal', () => {
  const cmp = makeTaskPriorityCmp(7);

  it('non-severe Due ranks before non-severe non-Due (even at lower urgency)', () => {
    const due    = { urgency_score: 5, due_state: true,  created_at: '2026-05-16T00:00:00Z' };
    const nonDue = { urgency_score: 6, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(due, nonDue) < 0, true);
  });
});

describe('taskPriorityCmp — urgency third, age last', () => {
  const cmp = makeTaskPriorityCmp(7);

  it('within same severity/due tier, higher urgency wins', () => {
    const high = { urgency_score: 6, due_state: false, created_at: '2026-05-16T00:00:00Z' };
    const low  = { urgency_score: 3, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(high, low) < 0, true);
  });

  it('within same urgency, older wins (FIFO tie-break)', () => {
    const newer = { urgency_score: 5, due_state: false, created_at: '2026-05-16T12:00:00Z' };
    const older = { urgency_score: 5, due_state: false, created_at: '2026-05-15T12:00:00Z' };
    assert.equal(cmp(older, newer) < 0, true);
  });
});

describe('taskPriorityCmp — null safety', () => {
  const cmp = makeTaskPriorityCmp(7);

  it('treats missing urgency_score as 0', () => {
    const noUrg = { urgency_score: null, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    const five  = { urgency_score: 5,    due_state: false, created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(noUrg, five) > 0, true);  // five wins
  });

  it('treats missing due_state as false', () => {
    const a = { urgency_score: 5, due_state: undefined, created_at: '2026-05-15T00:00:00Z' };
    const b = { urgency_score: 5, due_state: false,     created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(a, b), 0);
  });

  it('treats missing created_at as empty (sorts first under lex compare)', () => {
    const a = { urgency_score: 5, due_state: false, created_at: null };
    const b = { urgency_score: 5, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(a, b) < 0, true);
  });
});

describe('makeTaskPriorityCmp — threshold injection', () => {
  it('lowering threshold to 5 promotes urgency=5 into the severe band', () => {
    const cmp = makeTaskPriorityCmp(5);
    const five = { urgency_score: 5, due_state: false, created_at: '2026-05-15T00:00:00Z' };
    const four = { urgency_score: 4, due_state: true,  created_at: '2026-05-15T00:00:00Z' };
    assert.equal(cmp(five, four) < 0, true);  // severe(5) over Due(4)
  });

  it('default-bound taskPriorityCmp uses RELAI_DEFAULTS.severityUrgencyThreshold', () => {
    assert.equal(typeof RELAI_DEFAULTS.severityUrgencyThreshold, 'number');
    const arr = [
      { urgency_score: 3, due_state: false, created_at: '2026-05-15T00:00:00Z' },
      { urgency_score: 9, due_state: false, created_at: '2026-05-15T00:00:00Z' },
    ];
    arr.sort(taskPriorityCmp);
    assert.equal(arr[0].urgency_score, 9);
  });
});

// ─────────────────────────────────────────────────────────────────
// parsePullBody
// ─────────────────────────────────────────────────────────────────

describe('parsePullBody', () => {
  it('accepts a non-empty categories array', () => {
    const r = parsePullBody({ categories: ['Side Effects'] });
    assert.equal(r.ok, true);
    assert.equal(r.categories.length, 1);
    assert.equal(r.categories[0], 'Side Effects');
  });

  it('filters out non-string entries', () => {
    const r = parsePullBody({ categories: ['Side Effects', 123, null, 'Billing/Payment'] });
    assert.equal(r.ok, true);
    assert.equal(r.categories.length, 2);
    assert.deepEqual(r.categories, ['Side Effects', 'Billing/Payment']);
  });

  it('rejects an empty categories array', () => {
    const r = parsePullBody({ categories: [] });
    assert.equal(r.ok, false);
    assert.ok(/at least one category/i.test(r.error));
  });

  it('rejects when all entries are non-strings (effective empty)', () => {
    const r = parsePullBody({ categories: [1, null, true] });
    assert.equal(r.ok, false);
  });

  it('rejects a missing categories field', () => {
    assert.equal(parsePullBody({}).ok, false);
  });

  it('rejects non-object body shapes', () => {
    assert.equal(parsePullBody(null).ok, false);
    assert.equal(parsePullBody('').ok, false);
    assert.equal(parsePullBody(42).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseRetaskBody
// ─────────────────────────────────────────────────────────────────

describe('parseRetaskBody', () => {
  it('accepts a triage_id string', () => {
    const r = parseRetaskBody({ triage_id: 'abc-123' });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'abc-123');
  });

  it('trims whitespace around triage_id', () => {
    const r = parseRetaskBody({ triage_id: '  abc-123  ' });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'abc-123');
  });

  it('rejects missing triage_id', () => {
    assert.equal(parseRetaskBody({}).ok, false);
  });

  it('rejects empty / whitespace-only triage_id', () => {
    assert.equal(parseRetaskBody({ triage_id: '' }).ok, false);
    assert.equal(parseRetaskBody({ triage_id: '   ' }).ok, false);
  });

  it('rejects non-string triage_id', () => {
    assert.equal(parseRetaskBody({ triage_id: 123 }).ok, false);
    assert.equal(parseRetaskBody({ triage_id: null }).ok, false);
  });

  it('rejects null / non-object body', () => {
    assert.equal(parseRetaskBody(null).ok, false);
    assert.equal(parseRetaskBody('not-an-object').ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseReassignBody
// ─────────────────────────────────────────────────────────────────

describe('parseReassignBody', () => {
  it('accepts triage_id + new_category with no note', () => {
    const r = parseReassignBody({ triage_id: 'abc', new_category: 'Billing/Payment' });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'abc');
    assert.equal(r.newCategory, 'Billing/Payment');
    assert.equal(r.note, null);
  });

  it('accepts an optional note', () => {
    const r = parseReassignBody({ triage_id: 'a', new_category: 'X', note: 'Wrong queue' });
    assert.equal(r.note, 'Wrong queue');
  });

  it('truncates a long note to 1000 chars', () => {
    const long = 'x'.repeat(2000);
    const r = parseReassignBody({ triage_id: 'a', new_category: 'X', note: long });
    assert.equal(r.note.length, 1000);
  });

  it('coerces non-string note to null', () => {
    const r = parseReassignBody({ triage_id: 'a', new_category: 'X', note: 12345 });
    assert.equal(r.note, null);
  });

  it('rejects missing triage_id', () => {
    assert.equal(parseReassignBody({ new_category: 'X' }).ok, false);
  });

  it('rejects missing new_category', () => {
    assert.equal(parseReassignBody({ triage_id: 'a' }).ok, false);
  });

  it('rejects empty / whitespace-only fields', () => {
    assert.equal(parseReassignBody({ triage_id: '   ', new_category: 'X' }).ok, false);
    assert.equal(parseReassignBody({ triage_id: 'a', new_category: '   ' }).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseSendBody
// ─────────────────────────────────────────────────────────────────

describe('parseSendBody', () => {
  it('accepts triage_id + final_text within the length cap', () => {
    const r = parseSendBody({ triage_id: 'a', final_text: 'Hi patient' }, 1000);
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'a');
    assert.equal(r.finalText, 'Hi patient');
  });

  it('rejects empty final_text', () => {
    assert.equal(parseSendBody({ triage_id: 'a', final_text: '' }, 1000).ok, false);
  });

  it('rejects final_text exceeding the cap', () => {
    const longText = 'x'.repeat(1001);
    const r = parseSendBody({ triage_id: 'a', final_text: longText }, 1000);
    assert.equal(r.ok, false);
    assert.ok(/cap/i.test(r.error));
  });

  it('accepts final_text exactly at the cap', () => {
    const r = parseSendBody({ triage_id: 'a', final_text: 'x'.repeat(1000) }, 1000);
    assert.equal(r.ok, true);
  });

  it('rejects missing triage_id', () => {
    assert.equal(parseSendBody({ final_text: 'hello' }, 1000).ok, false);
  });

  it('rejects non-string final_text', () => {
    assert.equal(parseSendBody({ triage_id: 'a', final_text: 42 }, 1000).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseVoteBody
// ─────────────────────────────────────────────────────────────────

describe('parseVoteBody', () => {
  it('accepts an upvote with no reason', () => {
    const r = parseVoteBody({ triage_id: 'abc', vote: 'up' });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'abc');
    assert.equal(r.vote, 'up');
    assert.equal(r.reason, null);
  });

  it('accepts a downvote with a reason', () => {
    const r = parseVoteBody({ triage_id: 'abc', vote: 'down', reason: 'Too clinical for this patient' });
    assert.equal(r.ok, true);
    assert.equal(r.vote, 'down');
    assert.equal(r.reason, 'Too clinical for this patient');
  });

  it('lowercases the vote string', () => {
    assert.equal(parseVoteBody({ triage_id: 'a', vote: 'UP' }).vote, 'up');
    assert.equal(parseVoteBody({ triage_id: 'a', vote: 'Down' }).vote, 'down');
  });

  it('trims whitespace around triage_id and vote', () => {
    const r = parseVoteBody({ triage_id: '  abc  ', vote: '  up  ' });
    assert.equal(r.triageId, 'abc');
    assert.equal(r.vote, 'up');
  });

  it('truncates reason to 500 chars', () => {
    const long = 'x'.repeat(2000);
    const r = parseVoteBody({ triage_id: 'a', vote: 'up', reason: long });
    assert.equal(r.reason.length, 500);
  });

  it('rejects an unknown vote value', () => {
    assert.equal(parseVoteBody({ triage_id: 'a', vote: 'maybe' }).ok, false);
    assert.equal(parseVoteBody({ triage_id: 'a', vote: '' }).ok, false);
  });

  it('rejects missing triage_id', () => {
    assert.equal(parseVoteBody({ vote: 'up' }).ok, false);
  });

  it('rejects missing vote', () => {
    assert.equal(parseVoteBody({ triage_id: 'a' }).ok, false);
  });

  it('rejects null / non-object body', () => {
    assert.equal(parseVoteBody(null).ok, false);
    assert.equal(parseVoteBody('not-an-object').ok, false);
  });

  it('coerces non-string reason to null', () => {
    const r = parseVoteBody({ triage_id: 'a', vote: 'up', reason: 12345 });
    assert.equal(r.reason, null);
  });
});

// ─────────────────────────────────────────────────────────────────
// checkPullPrecondition — strict-batch refill + sticky-Due lock
// ─────────────────────────────────────────────────────────────────

describe('checkPullPrecondition — empty queue', () => {
  it('proceed=true for empty array', () => {
    assert.equal(checkPullPrecondition([], 5).proceed, true);
  });

  it('treats null / undefined as empty (proceed=true)', () => {
    assert.equal(checkPullPrecondition(null, 5).proceed, true);
    assert.equal(checkPullPrecondition(undefined, 5).proceed, true);
  });
});

describe('checkPullPrecondition — strict-batch refill', () => {
  it('returns 409 with reason=strict_batch when caller has open tasks', () => {
    const open = [
      { id: 'a', due_state: false },
      { id: 'b', due_state: false },
    ];
    const r = checkPullPrecondition(open, 5);
    assert.equal(r.proceed, false);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'strict_batch');
    assert.equal(r.body.pending_count, 2);
  });

  it('fires strict_batch even when only one task is held', () => {
    const r = checkPullPrecondition([{ id: 'a', due_state: false }], 5);
    assert.equal(r.body.reason, 'strict_batch');
    assert.equal(r.body.pending_count, 1);
  });
});

describe('checkPullPrecondition — sticky-Due queue lock', () => {
  it('returns reason=queue_lock_due when 5 of 5 tasks are Due', () => {
    const open = [
      { due_state: true }, { due_state: true }, { due_state: true },
      { due_state: true }, { due_state: true },
    ];
    const r = checkPullPrecondition(open, 5);
    assert.equal(r.proceed, false);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'queue_lock_due');
    assert.equal(r.body.due_count, 5);
  });

  it('falls back to strict_batch when not all are Due (4 Due + 1 non-Due, cap=5)', () => {
    const open = [
      { due_state: true }, { due_state: true }, { due_state: true },
      { due_state: true }, { due_state: false },
    ];
    const r = checkPullPrecondition(open, 5);
    assert.equal(r.body.reason, 'strict_batch');
  });

  it('queue_lock_due triggers at exactly cap Due, regardless of cap value', () => {
    const open = [{ due_state: true }, { due_state: true }];
    assert.equal(checkPullPrecondition(open, 2).body.reason, 'queue_lock_due');
  });
});

// ─────────────────────────────────────────────────────────────────
// splitCategoriesByEligibility — eligibility matrix
// ─────────────────────────────────────────────────────────────────

describe('splitCategoriesByEligibility', () => {
  const defaults = { routingHubCategory: 'Routing Hub', appTitles: ['MD', 'NP'] };
  const meta = {
    'Side Effects':    { is_clinical: true },
    'Billing/Payment': { is_clinical: false },
    'Routing Hub':     { is_clinical: false },
  };

  it('Non-Clinical: non-clinical + Routing Hub are "always"; clinical drops silently', () => {
    const r = splitCategoriesByEligibility(
      { role: 'Non-Clinical', title: 'CSR' },
      ['Billing/Payment', 'Routing Hub', 'Side Effects'],
      meta, defaults
    );
    assert.deepEqual(r.granted.slice().sort(), ['Billing/Payment', 'Routing Hub']);
    assert.deepEqual(r.idleOnly, []);
    assert.deepEqual(r.unknown, []);
  });

  it('Clinical RN: clinical is "always", non-clinical / Routing Hub are "idle_only"', () => {
    const r = splitCategoriesByEligibility(
      { role: 'Clinical', title: 'RN' },
      ['Side Effects', 'Billing/Payment', 'Routing Hub'],
      meta, defaults
    );
    assert.deepEqual(r.granted, ['Side Effects']);
    assert.deepEqual(r.idleOnly.slice().sort(), ['Billing/Payment', 'Routing Hub']);
  });

  it('APP tier (Clinical + MD): clinical "always"; non-clinical and Routing Hub are "never"', () => {
    const r = splitCategoriesByEligibility(
      { role: 'Clinical', title: 'MD' },
      ['Side Effects', 'Billing/Payment', 'Routing Hub'],
      meta, defaults
    );
    assert.deepEqual(r.granted, ['Side Effects']);
    assert.deepEqual(r.idleOnly, []);
  });

  it('reports unknown categories without raising', () => {
    const r = splitCategoriesByEligibility(
      { role: 'Non-Clinical', title: 'CSR' },
      ['Made Up Category', 'Billing/Payment'],
      meta, defaults
    );
    assert.deepEqual(r.granted, ['Billing/Payment']);
    assert.deepEqual(r.unknown, ['Made Up Category']);
  });

  it('handles a non-array requested input gracefully', () => {
    const r = splitCategoriesByEligibility({ role: 'Non-Clinical' }, null, meta, defaults);
    assert.deepEqual(r.granted, []);
    assert.deepEqual(r.idleOnly, []);
    assert.deepEqual(r.unknown, []);
  });
});

// ─────────────────────────────────────────────────────────────────
// partitionForClaim — first-pull vs re-pull split
// ─────────────────────────────────────────────────────────────────

describe('partitionForClaim', () => {
  it('rows without first_pulled_at → firstTime; rows with it → rePull', () => {
    const candidates = [
      { id: 'a', first_pulled_at: null },
      { id: 'b', first_pulled_at: '2026-05-16T12:00:00Z' },
      { id: 'c', first_pulled_at: null },
    ];
    const r = partitionForClaim(candidates);
    assert.equal(r.firstTime.length, 2);
    assert.equal(r.rePull.length, 1);
    assert.equal(r.firstTime[0].id, 'a');
    assert.equal(r.rePull[0].id, 'b');
  });

  it('empty array → both partitions empty', () => {
    const r = partitionForClaim([]);
    assert.equal(r.firstTime.length, 0);
    assert.equal(r.rePull.length, 0);
  });

  it('null input → both partitions empty', () => {
    const r = partitionForClaim(null);
    assert.equal(r.firstTime.length, 0);
    assert.equal(r.rePull.length, 0);
  });

  it('skips null / undefined entries inside the array', () => {
    const r = partitionForClaim([null, undefined, { id: 'a', first_pulled_at: null }]);
    assert.equal(r.firstTime.length, 1);
    assert.equal(r.rePull.length, 0);
  });

  it('treats empty-string first_pulled_at as first-time (truthy check)', () => {
    const r = partitionForClaim([{ id: 'a', first_pulled_at: '' }]);
    assert.equal(r.firstTime.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────
// dispatchOutbound — v1 stub behavior
// ─────────────────────────────────────────────────────────────────

describe('dispatchOutbound — sandbox kill-switch (default)', () => {
  // These tests run with OUTBOUND_LIVE_MODE *unset* — the default
  // state. Every non-manual channel must short-circuit to a
  // sandbox response: ok=true (so the UI doesn't show an error
  // during testing), sent_via=`sandbox:<channel>`, sandboxed=true.
  const task = { id: 't1' };
  const KEY = 'OUTBOUND_LIVE_MODE';

  it("manual channel: passes through regardless of mode (no external call to make)", async () => {
    const prior = process.env[KEY];
    try {
      delete process.env[KEY];
      const r = await dispatchOutbound('manual', task, 'reply');
      assert.equal(r.ok, true);
      assert.equal(r.sent_via, 'manual');
      assert.equal(r.sandboxed, undefined);
    } finally {
      if (prior !== undefined) process.env[KEY] = prior;
    }
  });

  it('intercom in default (sandbox) mode: ok=true, sent_via="sandbox:intercom", sandboxed=true', async () => {
    const prior = process.env[KEY];
    try {
      delete process.env[KEY];
      const r = await dispatchOutbound('intercom', task, 'reply');
      assert.equal(r.ok, true);
      assert.equal(r.sent_via, 'sandbox:intercom');
      assert.equal(r.sandboxed, true);
    } finally {
      if (prior !== undefined) process.env[KEY] = prior;
    }
  });

  it('healthie / bask / email / api: all sandboxed in default mode', async () => {
    const prior = process.env[KEY];
    try {
      delete process.env[KEY];
      for (const ch of ['healthie', 'bask', 'email', 'api']) {
        const r = await dispatchOutbound(ch, task, 'reply');
        assert.equal(r.ok, true, ch + ' should be ok');
        assert.equal(r.sent_via, 'sandbox:' + ch);
        assert.equal(r.sandboxed, true);
      }
    } finally {
      if (prior !== undefined) process.env[KEY] = prior;
    }
  });

  it('rejects non-"true" values as sandbox (defense vs typos)', async () => {
    const prior = process.env[KEY];
    try {
      for (const v of ['TRUE', '1', 'yes', 'on', 'true ']) {
        process.env[KEY] = v;
        const r = await dispatchOutbound('intercom', task, 'reply');
        assert.equal(r.sandboxed, true, 'should sandbox when LIVE_MODE=' + JSON.stringify(v));
      }
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });
});

describe('dispatchOutbound — live mode (OUTBOUND_LIVE_MODE=true)', () => {
  // When the operator has explicitly opted in to live outbound, the
  // sandbox short-circuit is skipped and dispatch falls through to
  // the per-channel stub (today) or the real adapter (Week 4+).
  const task = { id: 't1' };
  const KEY = 'OUTBOUND_LIVE_MODE';

  it("intercom in live mode: stub fires (sent_via='intercom:stub')", async () => {
    const prior = process.env[KEY];
    try {
      process.env[KEY] = 'true';
      const r = await dispatchOutbound('intercom', task, 'reply');
      assert.equal(r.ok, true);
      assert.equal(r.sent_via, 'intercom:stub');
      assert.equal(r.sandboxed, undefined);
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });

  it('unknown channel in live mode: ok=false with descriptive error', async () => {
    const prior = process.env[KEY];
    try {
      process.env[KEY] = 'true';
      const r = await dispatchOutbound('made-up-channel', task, 'reply');
      assert.equal(r.ok, false);
      assert.ok(/unknown channel/i.test(r.error));
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Exported constants
// ─────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('QUEUE_CAP is 5 (PLAN.md "Per-staff queue" cap)', () => {
    assert.equal(QUEUE_CAP, 5);
  });

  it('SEND_TEXT_MAX is a finite positive number', () => {
    assert.equal(typeof SEND_TEXT_MAX, 'number');
    assert.equal(SEND_TEXT_MAX > 0, true);
    assert.equal(Number.isFinite(SEND_TEXT_MAX), true);
  });
});
