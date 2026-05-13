// tests/promoteReviewToKB.test.js
//
// Direct unit tests for promoteReviewToKB (exported from
// netlify/functions/_lib/routes/reviews.js). This is the function
// that closes the active learning loop: when staff resolve an
// AI-flagged review with context=kb_gap or context=protocol, the
// answer is appended to kb_entries so the next triage benefits.
//
// roleGates.test.js exercises this through the resolve handler
// end-to-end, but doesn't assert the KB-write payload — the kb_entries
// route in that file's mock is "permissive so we don't crash, but
// tests don't depend on it." This file fills that gap by asserting
// the actual section mapping, position-append math, name truncation,
// and content shape.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const { promoteReviewToKB } = require('../netlify/functions/_lib/routes/reviews.js');

const realFetch = global.fetch;
let captured = null;

// Install a fetch mock that records every call and returns canned
// responses based on URL + method match.
function installFetchMock(routes) {
  captured = [];
  global.fetch = async function (url, opts) {
    captured.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    for (const route of routes) {
      if (route.match(url, method)) return makeResponse(route.respond(url, opts));
    }
    throw new Error('Unmocked fetch: ' + method + ' ' + url);
  };
}
function uninstallFetchMock() { global.fetch = realFetch; }

function makeResponse({ status = 200, body = null }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: () => null },
  };
}

// Build a route table with separate position-lookup and insert
// responses. Tests can override either.
function routes({ position = [], insertStatus = 200, insertBody = null } = {}) {
  return [
    {
      // Position lookup: GET kb_entries with order=position.desc
      match: (url, method) => method === 'GET' && url.includes('/rest/v1/kb_entries') && url.includes('order=position.desc'),
      respond: () => ({ status: 200, body: position }),
    },
    {
      // Insert: POST kb_entries
      match: (url, method) => method === 'POST' && url.includes('/rest/v1/kb_entries'),
      respond: () => ({ status: insertStatus, body: insertBody }),
    },
  ];
}

// Find the captured POST call to kb_entries (the insert).
function findInsert() {
  return captured.find(c => (c.opts && c.opts.method) === 'POST' && c.url.includes('/rest/v1/kb_entries'));
}

describe('promoteReviewToKB — section mapping', () => {
  it('maps context=kb_gap → section "notes"', async () => {
    installFetchMock(routes({ position: [{ position: 4 }] }));
    const r = await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap',
      question: 'Is X normal?', answer: 'Yes — see protocol Y',
    });
    uninstallFetchMock();
    assert.equal(r, 'notes');
    const ins = findInsert();
    const body = JSON.parse(ins.opts.body);
    assert.equal(body.section, 'notes');
  });

  it('maps context=protocol → section "protocols"', async () => {
    installFetchMock(routes({ position: [] }));
    const r = await promoteReviewToKB({
      companyId: 'co-1', context: 'protocol',
      question: 'When to escalate?', answer: 'If severity moderate+',
    });
    uninstallFetchMock();
    assert.equal(r, 'protocols');
    assert.equal(JSON.parse(findInsert().opts.body).section, 'protocols');
  });

  it('returns null (no promotion) for context=routing/severity/category/general', async () => {
    // None of these contexts should trigger a KB write. If a fetch
    // happens at all, our mock throws "Unmocked fetch" — so a passing
    // test confirms the function returned WITHOUT calling fetch.
    installFetchMock([]);
    for (const ctx of ['routing', 'severity', 'category', 'general']) {
      const r = await promoteReviewToKB({
        companyId: 'co-1', context: ctx, question: 'q', answer: 'a',
      });
      assert.equal(r, null, 'context=' + ctx + ' should not promote');
    }
    assert.equal(captured.length, 0, 'no fetches expected for non-kb-eligible contexts');
    uninstallFetchMock();
  });

  it('returns null (no promotion) for unknown context (defensive default)', async () => {
    installFetchMock([]);
    const r = await promoteReviewToKB({
      companyId: 'co-1', context: 'something_weird', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    assert.equal(r, null);
    assert.equal(captured.length, 0);
  });

  it('returns null (no promotion) when answer is empty', async () => {
    // An empty answer signals nothing useful to promote — the resolve
    // handler treats this as "kb_failed" so staff see something went
    // wrong instead of a misleading "saved" toast.
    installFetchMock([]);
    const r = await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: 'q', answer: '',
    });
    uninstallFetchMock();
    assert.equal(r, null);
    assert.equal(captured.length, 0);
  });
});

describe('promoteReviewToKB — position append math', () => {
  it('appends after the highest existing position (max + 1)', async () => {
    installFetchMock(routes({ position: [{ position: 12 }] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    const body = JSON.parse(findInsert().opts.body);
    assert.equal(body.position, 13);
  });

  it('starts at 0 when the section is empty', async () => {
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'protocol', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    const body = JSON.parse(findInsert().opts.body);
    assert.equal(body.position, 0);
  });

  it('starts at 0 when the position lookup returns a malformed shape', async () => {
    // Defensive: an unexpected response shape (string body, missing
    // position field, etc.) must not throw — just append at 0.
    installFetchMock(routes({ position: [{ /* no position key */ }] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    assert.equal(JSON.parse(findInsert().opts.body).position, 0);
  });
});

describe('promoteReviewToKB — name and content shape', () => {
  it('name truncates the question to 80 chars and prefixes "Resolved review — "', async () => {
    installFetchMock(routes({ position: [] }));
    const longQ = 'q'.repeat(200);
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: longQ, answer: 'a',
    });
    uninstallFetchMock();
    const body = JSON.parse(findInsert().opts.body);
    assert.equal(body.name.startsWith('Resolved review — '), true);
    // Question after the prefix should be exactly 80 chars (the slice).
    const trailingQ = body.name.slice('Resolved review — '.length);
    assert.equal(trailingQ.length, 80);
  });

  it('name uses ISO date as fallback when question is empty', async () => {
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: '', answer: 'a',
    });
    uninstallFetchMock();
    const body = JSON.parse(findInsert().opts.body);
    assert.match(body.name, /^Resolved review — \d{4}-\d{2}-\d{2}$/);
  });

  it('content shape is "Q: <question>\\n\\nA: <answer>"', async () => {
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap',
      question: 'Patient asked X', answer: 'Reassure and monitor',
    });
    uninstallFetchMock();
    const body = JSON.parse(findInsert().opts.body);
    assert.equal(body.content, 'Q: Patient asked X\n\nA: Reassure and monitor');
  });

  it('uses resolvedByName when provided, "Review queue" otherwise', async () => {
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap',
      question: 'q', answer: 'a', resolvedByName: 'Nurse Pat',
    });
    let body = JSON.parse(findInsert().opts.body);
    assert.equal(body.nurse_name, 'Nurse Pat');
    uninstallFetchMock();

    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap',
      question: 'q', answer: 'a', // no resolvedByName
    });
    body = JSON.parse(findInsert().opts.body);
    assert.equal(body.nurse_name, 'Review queue');
    uninstallFetchMock();
  });

  it('writes company_id from the argument (tenant scope)', async () => {
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co-12345', context: 'kb_gap', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    assert.equal(JSON.parse(findInsert().opts.body).company_id, 'co-12345');
  });
});

describe('promoteReviewToKB — error handling', () => {
  it('returns null when the kb_entries insert returns non-2xx', async () => {
    // The resolve handler reads this null as "kb_failed" so staff see
    // their answer didn't reach the KB. This contract is the keystone
    // of the three-state applied_to model.
    installFetchMock(routes({ position: [], insertStatus: 500, insertBody: { error: 'db error' } }));
    const r = await promoteReviewToKB({
      companyId: 'co-1', context: 'kb_gap', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    assert.equal(r, null);
  });

  it('returns null when fetch throws (network failure)', async () => {
    // Position lookup throws — function should swallow and proceed
    // with position=0. Then insert throws — function should swallow
    // and return null. End-to-end, no exceptions escape.
    global.fetch = async function () { throw new Error('ECONNREFUSED'); };
    let result;
    try {
      result = await promoteReviewToKB({
        companyId: 'co-1', context: 'kb_gap', question: 'q', answer: 'a',
      });
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(result, null);
  });
});

describe('promoteReviewToKB — companyId is encoded in URL queries', () => {
  it('URI-encodes companyId in the position lookup URL', async () => {
    // Defensive: a tenant id with reserved URL characters mustn't
    // break the query. Catches a regression where the query string
    // gets concatenated raw and the lookup URL becomes invalid.
    installFetchMock(routes({ position: [] }));
    await promoteReviewToKB({
      companyId: 'co with spaces & symbols',
      context: 'kb_gap', question: 'q', answer: 'a',
    });
    uninstallFetchMock();
    const lookupCall = captured.find(c => c.url.includes('order=position.desc'));
    assert.ok(lookupCall, 'no position lookup captured');
    assert.ok(
      lookupCall.url.includes(encodeURIComponent('co with spaces & symbols')),
      'companyId not URI-encoded in lookup URL: ' + lookupCall.url
    );
  });
});
