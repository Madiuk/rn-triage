// tests/roleGates.test.js
//
// End-to-end role gate tests for the /history and /reviews route
// handlers. Mocks global.fetch so we can run the handlers in Node
// without a real Supabase. The mock returns canned responses keyed
// off the request URL pattern so the test setup stays readable.
//
// What's tested:
//   - Non-clinical CANNOT delete a clinical-tier row (gate)
//   - Non-clinical CANNOT save_actual on a clinical-tier row (gate)
//   - Non-clinical CANNOT set body.category in update_category (gate)
//   - Non-clinical CAN delete a non-clinical row (no false positive)
//   - Non-clinical CANNOT resolve a clinical-origin review (gate)
//   - Non-clinical CAN resolve a non-clinical-origin review
//   - Clinical can do everything (no over-gating)
//
// Added in v0.4.0 (phase 1c). Before this, gate behavior was
// only verified by clicking through the app — which means
// regressions only surface in production. With these tests, a
// regression in any role gate becomes a CI failure.

// ─────────────────────────────────────────────────────────────────
// Set required env vars BEFORE requiring any handler module. The
// modules read process.env at load time (via _lib/supabase.js).
// ─────────────────────────────────────────────────────────────────
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const historyRoute = require('../netlify/functions/_lib/routes/history.js');
const reviewsRoute = require('../netlify/functions/_lib/routes/reviews.js');

// ─────────────────────────────────────────────────────────────────
// fetch mock — install a route table that returns canned responses
// based on URL substring + method. The actual production fetch is
// preserved so non-test runs aren't affected.
// ─────────────────────────────────────────────────────────────────

const realFetch = global.fetch;

// Mutable state — tests reset this before each scenario via
// installFetchMock(routes).
let _mockRoutes = [];

function installFetchMock(routes) {
  _mockRoutes = routes;
  global.fetch = async function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    for (const route of _mockRoutes) {
      if (route.match(url, method)) {
        return makeResponse(route.respond(url, opts));
      }
    }
    // Unmatched fetch — fail loudly so we notice missing mocks
    // instead of silently getting empty responses.
    throw new Error('Unmocked fetch: ' + method + ' ' + url);
  };
}

function uninstallFetchMock() {
  global.fetch = realFetch;
  _mockRoutes = [];
}

// Build a fetch-Response-like object that the handlers consume.
// They use .ok, .status, .text(), .json(), .headers.get().
function makeResponse({ status = 200, body = null, headers = {} }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: {
      get: (k) => headers[k.toLowerCase()] || headers[k] || null,
    },
  };
}

// Construct a Netlify-style event object for handlers.
function makeEvent({ method = 'GET', path = '/history', body = null, token = 'fake-bearer-token', queryStringParameters = null }) {
  return {
    httpMethod: method,
    path: path,
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { authorization: 'Bearer ' + token },
    queryStringParameters,
  };
}

// Decode a handler's Netlify response → a parsed object for assertions.
function decode(res) {
  let body = res.body;
  try { body = JSON.parse(res.body); } catch (e) { /* leave as string */ }
  return { status: res.statusCode, body };
}

// ─────────────────────────────────────────────────────────────────
// Canned profile + row fixtures used across scenarios
// ─────────────────────────────────────────────────────────────────

const CLINICAL_PROFILE   = { id: 'clinical-user-1',  company_id: 'company-1', role: 'Clinical',     is_admin: false, is_super_user: false, full_name: 'RN Test' };
const NON_CLINICAL_PROFILE = { id: 'non-clinical-1', company_id: 'company-1', role: 'Non-Clinical', is_admin: false, is_super_user: false, full_name: 'CSR Test' };

const CLINICAL_ROW    = { id: 'row-1', company_id: 'company-1', clinical_routing_level: 'mild', clinical_category: 'Side Effects', non_clinical_flag: false, non_clinical_items: [], escalated_to_clinical: false };
const NON_CLIN_ROW    = { id: 'row-2', company_id: 'company-1', clinical_routing_level: 'none', clinical_category: null,           non_clinical_flag: true,  non_clinical_items: ['Shipment/Tracking'], escalated_to_clinical: false };
const GENERAL_ROW     = { id: 'row-3', company_id: 'company-1', clinical_routing_level: 'none', clinical_category: 'General Inquiry', non_clinical_flag: false, non_clinical_items: [], escalated_to_clinical: false };
const CLIN_REVIEW     = { id: 'rev-1', company_id: 'company-1', triage_id: 'row-1', status: 'pending', context: 'kb_gap' };
const NON_CLIN_REVIEW = { id: 'rev-2', company_id: 'company-1', triage_id: 'row-2', status: 'pending', context: 'general' };

// Build a fetch-route table for a given scenario.
function buildMockRoutes({ user = CLINICAL_PROFILE, profile = CLINICAL_PROFILE, row = CLINICAL_ROW, review = null, captureRequests = null }) {
  return [
    // verifyUser → /auth/v1/user
    {
      match: (url) => url.includes('/auth/v1/user'),
      respond: () => ({ status: 200, body: { id: user.id, email: 'test@example.com' } }),
    },
    // resolveProfile / resolveCompanyId → /rest/v1/profiles?id=eq.<id>
    {
      match: (url) => url.includes('/rest/v1/profiles?id=eq.'),
      respond: () => ({ status: 200, body: [profile] }),
    },
    // fetchRowInTenant → /rest/v1/query_history?id=eq.<row>...
    {
      match: (url) => url.includes('/rest/v1/query_history?id=eq.'),
      respond: () => ({ status: 200, body: row ? [row] : [] }),
    },
    // PATCH /rest/v1/query_history (mutation target)
    {
      match: (url, method) => method === 'PATCH' && url.includes('/rest/v1/query_history'),
      respond: (url, opts) => {
        if (captureRequests) captureRequests.push({ url, body: opts && opts.body });
        return { status: 200, body: [row] };
      },
    },
    // DELETE /rest/v1/query_history
    {
      match: (url, method) => method === 'DELETE' && url.includes('/rest/v1/query_history'),
      respond: (url) => {
        if (captureRequests) captureRequests.push({ url });
        return { status: 200, body: [row] };
      },
    },
    // DELETE /rest/v1/review_requests (FK cleanup before delete_entry)
    {
      match: (url, method) => method === 'DELETE' && url.includes('/rest/v1/review_requests'),
      respond: () => ({ status: 200, body: [] }),
    },
    // GET /rest/v1/review_requests?id=eq.<id> (review lookup on resolve)
    {
      match: (url, method) => method === 'GET' && url.includes('/rest/v1/review_requests?id=eq.'),
      respond: () => ({ status: 200, body: review ? [review] : [] }),
    },
    // PATCH /rest/v1/review_requests (resolve / dismiss)
    {
      match: (url, method) => method === 'PATCH' && url.includes('/rest/v1/review_requests'),
      respond: () => ({ status: 200, body: [] }),
    },
    // Catch-all for KB writes during review resolve promotion —
    // permissive so we don't crash, but tests don't depend on it.
    {
      match: (url) => url.includes('/rest/v1/kb_entries'),
      respond: () => ({ status: 200, body: [] }),
    },
    // audit_log POST — best-effort, no asserts.
    {
      match: (url) => url.includes('/rest/v1/audit_log'),
      respond: () => ({ status: 200, body: null }),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('history role gates — non-clinical on CLINICAL row', () => {
  // Each test installs its own mock fixture (row=CLINICAL_ROW)
  // and asserts that mutating actions return 403 with the
  // documented error code.
  function setup() {
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: CLINICAL_ROW,
    }));
  }

  it('delete_entry → 403 clinical_only', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'delete_entry', id: CLINICAL_ROW.id },
    }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 403);
    assert.equal(body.code, 'clinical_only');
  });

  it('save_actual → 403 clinical_only', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'save_actual', id: CLINICAL_ROW.id, actual_response: 'Hi, here is my reply' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 403);
  });

  it('update_urgency → 403 clinical_only', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'update_urgency', id: CLINICAL_ROW.id, urgency_override: 'urgent' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 403);
  });

  it('downvote → 403 clinical_only', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'downvote', id: CLINICAL_ROW.id, reason: 'bad draft' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 403);
  });

  it('update_category with body.category set → 403 clinical_only', async () => {
    // The category gate is special: it rejects on body shape
    // (presence of 'category' key) without needing to fetch the
    // row. Verifies the under-gate works even for empty bodies.
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'update_category', id: CLINICAL_ROW.id, category: 'Side Effects' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 403);
  });
});

describe('history role gates — non-clinical on NON-CLINICAL row', () => {
  // No gates should fire — non-clinical staff handle these
  // routinely. If any of these returned 403, we'd be over-gating
  // and breaking Zack's day.
  function setup(captureRequests) {
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: NON_CLIN_ROW,
      captureRequests,
    }));
  }

  it('save_actual on non-clinical → 200', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'save_actual', id: NON_CLIN_ROW.id, actual_response: 'Shipping update sent.' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });

  it('delete_entry on non-clinical → 200', async () => {
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'delete_entry', id: NON_CLIN_ROW.id },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });

  it('update_category with non_clinical_items → 200', async () => {
    // Editing non_clinical_items without touching body.category
    // is the CSR's legitimate use case. Must succeed.
    setup();
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: {
        action: 'update_category',
        id: NON_CLIN_ROW.id,
        non_clinical_items: ['Billing/Payment'],
        non_clinical_flag: true,
      },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });
});

describe('history role gates — General Inquiry is treated as non-clinical', () => {
  // Per Big Easy's category_metadata seed, General Inquiry is
  // is_clinical=false. Non-clinical should be able to mutate
  // General Inquiry rows freely.
  it('non-clinical save_actual on General Inquiry row → 200', async () => {
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: GENERAL_ROW,
    }));
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'save_actual', id: GENERAL_ROW.id, actual_response: 'Thanks for reaching out!' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });
});

describe('history role gates — clinical user is never gated', () => {
  // No over-gating: clinical can do everything on any row.
  function setup(row) {
    installFetchMock(buildMockRoutes({
      user: CLINICAL_PROFILE,
      profile: CLINICAL_PROFILE,
      row,
    }));
  }

  it('clinical can delete clinical rows', async () => {
    setup(CLINICAL_ROW);
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'delete_entry', id: CLINICAL_ROW.id },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });

  it('clinical can save_actual on clinical rows', async () => {
    setup(CLINICAL_ROW);
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'save_actual', id: CLINICAL_ROW.id, actual_response: 'Clinical reply' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });

  it('clinical can update_category with body.category', async () => {
    setup(CLINICAL_ROW);
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'update_category', id: CLINICAL_ROW.id, category: 'Injection/Dosing' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });
});

describe('history mark_escalated — any role can call', () => {
  it('non-clinical mark_escalated on clinical row → 200 (not 403)', async () => {
    // Escalation is the CSR's outlet on clinical content. It
    // MUST succeed even though the row is clinical — otherwise
    // the non-clinical workflow can't actually route to clinical.
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: CLINICAL_ROW,
    }));
    const res = await historyRoute.handle(makeEvent({
      method: 'POST', path: '/history',
      body: { action: 'mark_escalated', id: CLINICAL_ROW.id, actual_response: 'Handoff sent.' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });
});

describe('reviews role gates — non-clinical resolving clinical review', () => {
  it('non-clinical resolving clinical-origin review → 403 clinical_only', async () => {
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: CLINICAL_ROW,         // the origin triage is clinical
      review: CLIN_REVIEW,       // and the review points at it
    }));
    const res = await reviewsRoute.handle(makeEvent({
      method: 'POST', path: '/reviews',
      body: { action: 'resolve', id: CLIN_REVIEW.id, answer: 'CSR thinks the answer is X', context: 'kb_gap' },
    }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 403);
    assert.equal(body.code, 'clinical_only');
  });

  it('non-clinical resolving non-clinical-origin review → 200', async () => {
    installFetchMock(buildMockRoutes({
      user: NON_CLINICAL_PROFILE,
      profile: NON_CLINICAL_PROFILE,
      row: NON_CLIN_ROW,
      review: NON_CLIN_REVIEW,
    }));
    const res = await reviewsRoute.handle(makeEvent({
      method: 'POST', path: '/reviews',
      body: { action: 'resolve', id: NON_CLIN_REVIEW.id, answer: 'Shipping clarification', context: 'general' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });

  it('clinical resolving clinical review → 200', async () => {
    installFetchMock(buildMockRoutes({
      user: CLINICAL_PROFILE,
      profile: CLINICAL_PROFILE,
      row: CLINICAL_ROW,
      review: CLIN_REVIEW,
    }));
    const res = await reviewsRoute.handle(makeEvent({
      method: 'POST', path: '/reviews',
      body: { action: 'resolve', id: CLIN_REVIEW.id, answer: 'Clinical answer to gap', context: 'kb_gap' },
    }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 200);
  });
});
