// tests/authStaff.test.js
//
// Contract tests for GET /auth/staff in netlify/functions/auth.js
// (phase 1 — the roster endpoint the Staff admin tab reads).
//
// The endpoint is thin (super-user gate + tenant-scoped read), but
// every gate matters for tenant safety. Coverage:
//
//   * Bearer token required (401).
//   * Token verified with Supabase Auth (401 if rejected).
//   * Missing profile → 403 super_user_only (fail closed).
//   * Non-super-user caller refused (403 super_user_only).
//   * Super-user without company_id refused (400).
//   * Happy path: 200, body.staff is the upstream profiles array.
//   * Tenant scope: the upstream profiles query MUST include
//     `company_id=eq.<callers-tenant>` in the URL — defense
//     against a future refactor accidentally widening the scope to
//     a cross-tenant read.
//   * Defensive: non-array upstream response → 500 rather than
//     surfacing a malformed payload.

process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const authMod = require('../netlify/functions/auth.js');

const realFetch = global.fetch;
let captured = null;

function installFetchMock(routes) {
  captured = [];
  global.fetch = async function (url, opts) {
    captured.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    for (const route of routes) {
      if (route.match(url, method)) {
        return makeResponse(route.respond(url, opts));
      }
    }
    throw new Error('Unmocked fetch: ' + method + ' ' + url);
  };
}
function uninstallFetchMock() {
  global.fetch = realFetch;
  captured = null;
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
function makeEvent({ method = 'GET', token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path: '/.netlify/functions/auth/staff',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: null,
  };
}

// ── fixtures ───────────────────────────────────────────────────────

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const PROFILE_SUPER_IN_A   = { is_super_user: true,  company_id: TENANT_A };
const PROFILE_NON_SUPER    = { is_super_user: false, company_id: TENANT_A };
const PROFILE_SUPER_NO_TEN = { is_super_user: true,  company_id: null };

// A roster the upstream would return for company_id=TENANT_A.
const TENANT_A_ROSTER = [
  { id: CALLER_ID, email: 'super@test.local', role: 'Clinical', is_super_user: true,  accepted_at: '2026-05-01T10:00:00Z' },
  { id: '22222222-2222-2222-2222-222222222222', email: 'rn@test.local', role: 'Clinical', is_super_user: false, accepted_at: '2026-05-05T10:00:00Z' },
];

const r = {
  authOK: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 200, body: { id: CALLER_ID, email: 'super@test.local' } }),
  }),
  authRejected: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 401, body: { error: 'Invalid token' } }),
  }),
  callerProfile: (prof) => ({
    // Matches the caller-profile lookup (id filter), NOT the roster
    // lookup (company_id filter). The two routes are distinguished
    // below by which filter substring appears in the URL.
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + CALLER_ID),
    respond: () => ({ status: 200, body: prof ? [prof] : [] }),
  }),
  rosterOK: (rows) => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?company_id=eq.'),
    respond: () => ({ status: 200, body: rows }),
  }),
};

function assertNoRosterCall() {
  const rosterCalls = (captured || []).filter(c =>
    c.url.includes('/rest/v1/profiles?company_id=eq.'));
  assert.equal(rosterCalls.length, 0,
    'roster query was made before all gates passed. Captured: ' +
    JSON.stringify((captured || []).map(c => c.url)));
}

// ── tests ──────────────────────────────────────────────────────────

describe('/auth/staff — auth gate (regression: no roster read until all checks pass)', () => {

  it('rejects missing Bearer token with 401', async () => {
    installFetchMock([]);
    try {
      const res = await authMod.handler(makeEvent({ token: null }));
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /No token/i);
      assertNoRosterCall();
      assert.equal(captured.length, 0, 'no upstream calls when token absent');
    } finally { uninstallFetchMock(); }
  });

  it('rejects token Supabase rejects with 401', async () => {
    installFetchMock([r.authRejected()]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /Invalid token/i);
      assertNoRosterCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects valid token whose profile is missing (403 super_user_only — fail closed)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(null)]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, 'super_user_only');
      assertNoRosterCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-super-user caller (403 super_user_only)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_NON_SUPER)]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, 'super_user_only');
      assertNoRosterCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects super-user with no company_id (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_SUPER_NO_TEN)]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /no company_id/i);
      assertNoRosterCall();
    } finally { uninstallFetchMock(); }
  });
});

describe('/auth/staff — happy path + tenant scope', () => {

  it('200; returns the upstream roster as body.staff', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.rosterOK(TENANT_A_ROSTER),
    ]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 200);
      const j = JSON.parse(res.body);
      assert.ok(Array.isArray(j.staff), 'body.staff must be an array');
      assert.equal(j.staff.length, TENANT_A_ROSTER.length);
      assert.equal(j.staff[0].id, TENANT_A_ROSTER[0].id);
    } finally { uninstallFetchMock(); }
  });

  it('roster query is hard-scoped to caller company_id (no cross-tenant leak)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.rosterOK(TENANT_A_ROSTER),
    ]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 200);
      const rosterCall = (captured || []).find(c =>
        c.url.includes('/rest/v1/profiles?company_id=eq.'));
      assert.ok(rosterCall, 'roster query was not made');
      // The URL MUST contain the caller's tenant in the company_id
      // filter — no other tenant id, no missing filter, no wildcard.
      assert.ok(
        rosterCall.url.includes('company_id=eq.' + TENANT_A),
        'roster URL must hard-scope to caller tenant; got: ' + rosterCall.url
      );
    } finally { uninstallFetchMock(); }
  });

  it('upstream non-array response → 500 (defensive)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      // PostgREST sometimes returns an object with `code`/`message`
      // on error rather than an array; the handler must not
      // surface that as a staff list.
      { match: (u, m) => m === 'GET' && u.includes('/rest/v1/profiles?company_id=eq.'),
        respond: () => ({ status: 200, body: { code: 'PGRST116', message: 'something' } }) },
    ]);
    try {
      const res = await authMod.handler(makeEvent());
      assert.equal(res.statusCode, 500);
      assert.match(JSON.parse(res.body).error, /fetch failed/i);
    } finally { uninstallFetchMock(); }
  });
});
