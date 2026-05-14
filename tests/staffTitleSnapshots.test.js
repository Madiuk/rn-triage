// tests/staffTitleSnapshots.test.js
//
// Contract tests for the role/title snapshot rails introduced in
// migration 0017. The columns are written by the server-side route
// handlers and not yet read by anything — exactly the kind of
// foundation that breaks silently when a future refactor drops the
// field. Lock the boundary here so future drift trips CI instead of
// quietly losing months of segmentable training data.
//
// Coverage:
//   1. POST /history default insert (the create branch in
//      _lib/routes/history.js) MUST include user_role + user_title
//      from the server-verified profile in the upstream
//      INSERT body, NEVER from the request body.
//   2. POST /reviews action=resolve (in _lib/routes/reviews.js) MUST
//      include resolved_by_role + resolved_by_title in the upstream
//      PATCH body, sourced from callerProfile.
//   3. POST /auth/invite accepts an optional `title` in the body
//      allowlist; oversized titles (>24 chars after trim) are
//      rejected with 400 before any upstream write fires.
//
// Server-forcing matters: the same defense-in-depth that protects
// user_id/company_id from client tampering protects user_role and
// user_title. A malicious client cannot ship `{user_title: 'MD'}`
// to launder a non-clinical correction into the future clinical
// training pool.

// ── env ────────────────────────────────────────────────────────────
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const historyRoute = require('../netlify/functions/_lib/routes/history.js');
const reviewsRoute = require('../netlify/functions/_lib/routes/reviews.js');
const authMod      = require('../netlify/functions/auth.js');

// ── fetch mock harness (mirrors roleGates.test.js style) ───────────

const realFetch = global.fetch;
let _routes = [];
let _captured = [];

function installFetchMock(routes) {
  _routes = routes;
  _captured = [];
  global.fetch = async function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    _captured.push({ url, method, body: opts && opts.body });
    for (const r of _routes) {
      if (r.match(url, method)) return makeResponse(r.respond(url, opts));
    }
    throw new Error('Unmocked fetch: ' + method + ' ' + url);
  };
}
function uninstallFetchMock() {
  global.fetch = realFetch;
  _routes = [];
  _captured = [];
}
function makeResponse({ status = 200, body = null }) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (body == null ? null : (typeof body === 'string' ? JSON.parse(body) : body)),
    headers: { get: () => null },
  };
}
function makeEvent({ method = 'POST', path = '/history', body = null, token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path,
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { authorization: 'Bearer ' + token },
  };
}

// ── fixtures ───────────────────────────────────────────────────────

const USER_ID  = 'user-id-1';
const TENANT   = 'tenant-1';
const PROFILE_CLINICAL_MD = {
  id: USER_ID, company_id: TENANT, role: 'Clinical', title: 'MD',
  is_admin: false, is_super_user: false, full_name: 'Dr. Test'
};
const PROFILE_NONCLIN_CSR = {
  id: USER_ID, company_id: TENANT, role: 'Non-Clinical', title: 'CSR',
  is_admin: true, is_super_user: false, full_name: 'CSR Test'
};
const PROFILE_CLINICAL_ADMIN_RN = {
  id: USER_ID, company_id: TENANT, role: 'Clinical', title: 'RN',
  is_admin: true, is_super_user: false, full_name: 'Admin RN'
};
const REVIEW_KB_GAP = {
  id: 'rev-1', company_id: TENANT, triage_id: 'row-1',
  status: 'pending', context: 'kb_gap', question: 'Q'
};
const NON_CLIN_ROW = {
  id: 'row-1', company_id: TENANT,
  clinical_routing_level: 'none', clinical_category: null,
  non_clinical_flag: true, non_clinical_items: ['Shipment/Tracking']
};

function baseRoutes(profile, { reviewRow = null, triageRow = null } = {}) {
  return [
    { match: (u) => u.includes('/auth/v1/user'),
      respond: () => ({ status: 200, body: { id: USER_ID, email: 't@test.local' } }) },
    // Profiles GET only — leave PATCH unmatched so test-specific
    // routes installed before this one can capture profile mutations.
    { match: (u, m) => m === 'GET' && u.includes('/rest/v1/profiles?id=eq.'),
      respond: () => ({ status: 200, body: [profile] }) },
    { match: (u, m) => m === 'GET' && u.includes('/rest/v1/query_history?id=eq.'),
      respond: () => ({ status: 200, body: triageRow ? [triageRow] : [] }) },
    { match: (u, m) => m === 'GET' && u.includes('/rest/v1/review_requests?id=eq.'),
      respond: () => ({ status: 200, body: reviewRow ? [reviewRow] : [] }) },
    { match: (u) => u.includes('/rest/v1/audit_log'),
      respond: () => ({ status: 200, body: null }) },
    { match: (u) => u.includes('/rest/v1/kb_entries'),
      respond: () => ({ status: 200, body: [] }) },
    { match: (u) => u.includes('/rest/v1/company_members'),
      respond: () => ({ status: 201, body: null }) },
    { match: (u) => u.includes('/auth/v1/admin/users'),
      respond: () => ({ status: 200, body: { id: 'new-user-id', email: 'inv@test.local' } }) },
  ];
}

function findInsert(urlPattern) {
  return _captured.find(c => c.method === 'POST' && c.url.includes(urlPattern) && c.body);
}
function findPatch(urlPattern) {
  return _captured.find(c => c.method === 'PATCH' && c.url.includes(urlPattern) && c.body);
}

// ── tests ──────────────────────────────────────────────────────────

describe('migration 0017 — staff title + role snapshots on query_history', () => {

  it('default insert forces user_role + user_title from caller profile', async () => {
    installFetchMock([
      ...baseRoutes(PROFILE_CLINICAL_MD),
      // The query_history INSERT — capture and return success.
      { match: (u, m) => m === 'POST' && u.endsWith('/rest/v1/query_history'),
        respond: () => ({ status: 201, body: [{ id: 'new-row' }] }) },
    ]);
    try {
      // Client body MUST NOT control snapshot fields. Send a hostile
      // attempt to forge user_role/user_title; the server must
      // overwrite them with profile values.
      const res = await historyRoute.handle(makeEvent({
        method: 'POST', path: '/history',
        body: { patient_message: 'hello', user_role: 'Non-Clinical', user_title: 'FORGED' },
      }));
      assert.equal(res.statusCode, 201);

      const insert = findInsert('/rest/v1/query_history');
      assert.ok(insert, 'expected POST to /rest/v1/query_history');
      const insertBody = JSON.parse(insert.body);
      assert.equal(insertBody.user_role,  'Clinical', 'user_role must come from server-verified profile');
      assert.equal(insertBody.user_title, 'MD',       'user_title must come from server-verified profile');
      assert.equal(insertBody.user_id,    USER_ID,    'user_id must be server-forced (existing protection still holds)');
      assert.equal(insertBody.company_id, TENANT,     'company_id must be server-forced (existing protection still holds)');
    } finally { uninstallFetchMock(); }
  });

  it('insert sets snapshot fields to null when profile lacks them', async () => {
    // Edge case: a legacy profile row that hasn't been backfilled
    // (title is undefined/null). Server should not crash; it should
    // write null rather than letting the client's forged value land.
    const legacyProfile = { id: USER_ID, company_id: TENANT, role: 'Clinical', is_admin: false, is_super_user: false, full_name: 'Legacy' };
    installFetchMock([
      ...baseRoutes(legacyProfile),
      { match: (u, m) => m === 'POST' && u.endsWith('/rest/v1/query_history'),
        respond: () => ({ status: 201, body: [{ id: 'new-row' }] }) },
    ]);
    try {
      const res = await historyRoute.handle(makeEvent({
        method: 'POST', path: '/history',
        body: { patient_message: 'hello', user_title: 'FORGED' },
      }));
      assert.equal(res.statusCode, 201);
      const insertBody = JSON.parse(findInsert('/rest/v1/query_history').body);
      assert.equal(insertBody.user_role,  'Clinical');
      assert.equal(insertBody.user_title, null, 'missing title on profile must serialize as null, not the forged value');
    } finally { uninstallFetchMock(); }
  });
});

describe('migration 0017 — staff title + role snapshots on review_requests', () => {

  it('resolve writes resolved_by_role + resolved_by_title from caller profile', async () => {
    installFetchMock([
      ...baseRoutes(PROFILE_CLINICAL_MD, { reviewRow: REVIEW_KB_GAP, triageRow: NON_CLIN_ROW }),
      // PATCH /rest/v1/review_requests — the resolve PATCH target.
      { match: (u, m) => m === 'PATCH' && u.includes('/rest/v1/review_requests'),
        respond: () => ({ status: 204, body: null }) },
    ]);
    try {
      const res = await reviewsRoute.handle(makeEvent({
        method: 'POST', path: '/reviews',
        body: {
          action: 'resolve', id: REVIEW_KB_GAP.id,
          answer: 'Test answer', context: 'kb_gap',
          // Hostile attempt to forge resolver credential — must be
          // overwritten by server-verified profile.
          resolved_by_role: 'Non-Clinical', resolved_by_title: 'FORGED',
        },
      }));
      assert.equal(res.statusCode, 200);
      const patch = findPatch('/rest/v1/review_requests');
      assert.ok(patch, 'expected PATCH to /rest/v1/review_requests');
      const patchBody = JSON.parse(patch.body);
      assert.equal(patchBody.resolved_by_role,  'Clinical', 'resolved_by_role must come from server-verified profile');
      assert.equal(patchBody.resolved_by_title, 'MD',       'resolved_by_title must come from server-verified profile');
      assert.equal(patchBody.resolved_by,       USER_ID,    'resolved_by must remain server-forced');
    } finally { uninstallFetchMock(); }
  });
});

describe('migration 0017 — /auth/invite accepts and validates title', () => {

  it('accepts a valid title and passes it into the profile PATCH', async () => {
    // PATCH body capture for /rest/v1/profiles?id=eq.<newUser>.
    let capturedProfilePatch = null;
    installFetchMock([
      ...baseRoutes(PROFILE_CLINICAL_ADMIN_RN),
      { match: (u, m) => m === 'PATCH' && u.includes('/rest/v1/profiles?id=eq.new-user-id'),
        respond: (url, opts) => { capturedProfilePatch = opts && opts.body; return { status: 204, body: null }; } },
    ]);
    try {
      const res = await authMod.handler({
        httpMethod: 'POST',
        path: '/.netlify/functions/auth/invite',
        headers: { authorization: 'Bearer fake-token' },
        body: JSON.stringify({ email: 'new@test.local', role: 'Clinical', title: 'NP' }),
      });
      assert.equal(res.statusCode, 200);
      assert.ok(capturedProfilePatch, 'expected PATCH to /rest/v1/profiles for new user');
      const patchBody = JSON.parse(capturedProfilePatch);
      assert.equal(patchBody.role,  'Clinical');
      assert.equal(patchBody.title, 'NP', 'title from body must flow into the profile PATCH');
    } finally { uninstallFetchMock(); }
  });

  it('rejects oversized title (>24 chars) with 400 before any upstream write', async () => {
    installFetchMock(baseRoutes(PROFILE_CLINICAL_ADMIN_RN));
    try {
      const res = await authMod.handler({
        httpMethod: 'POST',
        path: '/.netlify/functions/auth/invite',
        headers: { authorization: 'Bearer fake-token' },
        body: JSON.stringify({
          email: 'new@test.local', role: 'Clinical',
          title: 'this title is way too long to be a credential',
        }),
      });
      assert.equal(res.statusCode, 400);
      const errBody = JSON.parse(res.body);
      assert.match(errBody.error, /24 characters/i);
      // Regression guard: NO admin/users create until validation passed.
      const adminCalls = _captured.filter(c => /\/auth\/v1\/admin\/users$/.test(c.url) && c.method === 'POST');
      assert.equal(adminCalls.length, 0, 'no upstream user create until all validation passes');
    } finally { uninstallFetchMock(); }
  });

  it('rejects unknown body key (regression guard on the title allowlist addition)', async () => {
    installFetchMock(baseRoutes(PROFILE_CLINICAL_ADMIN_RN));
    try {
      const res = await authMod.handler({
        httpMethod: 'POST',
        path: '/.netlify/functions/auth/invite',
        headers: { authorization: 'Bearer fake-token' },
        body: JSON.stringify({ email: 'x@y.z', role: 'Clinical', title: 'RN', is_super_user: true }),
      });
      assert.equal(res.statusCode, 400);
      const errBody = JSON.parse(res.body);
      assert.match(errBody.error, /Unexpected body key/i);
    } finally { uninstallFetchMock(); }
  });
});
