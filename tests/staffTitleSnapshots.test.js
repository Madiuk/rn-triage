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
//   3. POST /auth/invite (post mig-0030 rewrite) accepts a `suffix`
//      and back-compat populates profile.title from it on INSERT, so
//      the snapshot-rail code in history.js/reviews.js keeps working.
//      Oversized suffixes (>24 chars after trim) are rejected with
//      400 before any upstream invite fires.
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
// Post mig-0030 the invite gate is is_super_user, not is_admin. The
// fixture is_admin flag is kept (some legacy tests may read it) but
// the value that gates /auth/invite is is_super_user.
const PROFILE_CLINICAL_SUPER_RN = {
  id: USER_ID, company_id: TENANT, role: 'Clinical', title: 'RN',
  is_admin: true, is_super_user: true, full_name: 'Super RN'
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
    { match: (u) => u.endsWith('/auth/v1/invite'),
      respond: () => ({ status: 200, body: { id: 'new-user-id', email: 'inv@test.local' } }) },
    // Post mig-0030: invite path INSERTs the profile row immediately
    // (was a PATCH against the auto-created row before). Provide the
    // mock here so the third describe block can capture the body.
    { match: (u, m) => m === 'POST' && u.endsWith('/rest/v1/profiles'),
      respond: () => ({ status: 201, body: null }) },
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

describe('migration 0017 + 0030 — /auth/invite back-compat populates profile.title from suffix', () => {

  // Why this lives in the snapshot-rail test file: history.js and
  // reviews.js still read profile.title to populate user_title /
  // resolved_by_title snapshot columns (mig 0017). Mig 0030 renamed
  // the column on the API surface (title → suffix) but kept title as
  // a populated alias on the row to preserve those rails. If a
  // future refactor drops the title= line in the invite handler,
  // this test trips before the snapshot columns silently start
  // filling with NULL.
  it('INSERTs the profile row with title mirroring suffix', async () => {
    // POST body capture for /rest/v1/profiles. Capturing route goes
    // FIRST so it wins over the generic baseRoutes profiles-INSERT
    // (the mock walks routes in order and returns the first match).
    let capturedProfileInsert = null;
    installFetchMock([
      { match: (u, m) => m === 'POST' && u.endsWith('/rest/v1/profiles'),
        respond: (url, opts) => { capturedProfileInsert = opts && opts.body; return { status: 201, body: null }; } },
      ...baseRoutes(PROFILE_CLINICAL_SUPER_RN),
    ]);
    try {
      const res = await authMod.handler({
        httpMethod: 'POST',
        path: '/.netlify/functions/auth/invite',
        headers: { authorization: 'Bearer fake-token' },
        body: JSON.stringify({
          email: 'new@test.local',
          first_name: 'Alex',
          last_name: 'Lee',
          role: 'Clinical',
          suffix: 'NP',
        }),
      });
      assert.equal(res.statusCode, 200);
      assert.ok(capturedProfileInsert, 'expected POST to /rest/v1/profiles for new user');
      const insertBody = JSON.parse(capturedProfileInsert);
      assert.equal(insertBody.role, 'Clinical');
      assert.equal(insertBody.suffix, 'NP', 'suffix from body must land on the profile row');
      assert.equal(insertBody.title,  'NP', 'title must mirror suffix for mig-0017 snapshot back-compat');
    } finally { uninstallFetchMock(); }
  });

  it('rejects oversized suffix (>24 chars) with 400 before any upstream invite', async () => {
    installFetchMock(baseRoutes(PROFILE_CLINICAL_SUPER_RN));
    try {
      const res = await authMod.handler({
        httpMethod: 'POST',
        path: '/.netlify/functions/auth/invite',
        headers: { authorization: 'Bearer fake-token' },
        body: JSON.stringify({
          email: 'new@test.local',
          first_name: 'Alex',
          last_name: 'Lee',
          role: 'Clinical',
          suffix: 'this suffix is way too long to be a credential',
        }),
      });
      assert.equal(res.statusCode, 400);
      const errBody = JSON.parse(res.body);
      assert.match(errBody.error, /24 characters/i);
      // Regression guard: NO upstream invite until validation passed.
      const inviteCalls = _captured.filter(c => /\/auth\/v1\/invite$/.test(c.url) && c.method === 'POST');
      assert.equal(inviteCalls.length, 0, 'no upstream invite until all validation passes');
    } finally { uninstallFetchMock(); }
  });
});
