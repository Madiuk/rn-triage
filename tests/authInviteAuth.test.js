// tests/authInviteAuth.test.js
//
// End-to-end tests for POST /auth/invite in netlify/functions/auth.js.
//
// Before this hardening, the handler had no caller auth at all — anyone
// with the URL could create a confirmed Supabase user attached to any
// company_id with any role. RELAI_VALIDATION_AUDIT.md flagged it as
// the highest-severity finding in the function set: a one-curl
// tenant-takeover vector.
//
// Coverage:
//   * Bearer token required (401).
//   * Token must verify with Supabase Auth (401 if rejected).
//   * Profile lookup; non-admin caller refused (403, code=admin_only).
//   * Admin caller without company_id refused (400).
//   * Body must be valid JSON (400 if not).
//   * Body key allowlist — unexpected keys (is_super_user) refused (400).
//   * email required (400 if missing) — preserves legacy behavior.
//   * role must be in {Clinical, Non-Clinical, staff} (400 otherwise).
//   * Cross-tenant invite (body.company_id != caller's tenant) refused
//     (403, code=cross_tenant).
//   * Happy path: 200 with success=true, upstream calls hit correct
//     URLs with caller's company_id forced.
//
// Side-effect regression guard (applied to every rejection test): the
// upstream POST /auth/v1/admin/users MUST NOT be called when any gate
// returns early. A future refactor that reorders validation would trip
// this assertion before any tenant data was touched.
//
// Mock pattern follows triageProxy.test.js. Tests serialize via the
// runner, so the global.fetch slot is safe to swap in/out per test.

// Env vars must be set BEFORE requiring auth.js — the handler reads
// them at module load time.
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const authMod = require('../netlify/functions/auth.js');

// ── fetch mock harness ─────────────────────────────────────────────

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
    json: async () => {
      if (body == null) return null;
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    headers: { get: () => null },
  };
}

function makeEvent({ method = 'POST', body = null, token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path: '/.netlify/functions/auth/invite',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// ── route fixtures ─────────────────────────────────────────────────

const CALLER_ID   = '11111111-1111-1111-1111-111111111111';
const TENANT_A    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NEW_USER_ID = '22222222-2222-2222-2222-222222222222';

const PROFILE_ADMIN_IN_A    = { is_admin: true,  is_super_user: false, company_id: TENANT_A };
const PROFILE_NON_ADMIN     = { is_admin: false, is_super_user: false, company_id: TENANT_A };
const PROFILE_ADMIN_NO_TEN  = { is_admin: true,  is_super_user: false, company_id: null };

// Route builders.
const r = {
  authOK: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 200, body: { id: CALLER_ID, email: 'admin@test.local' } }),
  }),
  authRejected: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 401, body: { error: 'Invalid token' } }),
  }),
  // Profile lookup uses select=is_admin,is_super_user,company_id — match
  // on the id filter so the test isn't coupled to the exact select list.
  profile: (prof) => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + CALLER_ID),
    respond: () => ({ status: 200, body: prof ? [prof] : [] }),
  }),
  adminCreateOK: () => ({
    match: (url, m) => m === 'POST' && url.endsWith('/auth/v1/admin/users'),
    respond: () => ({ status: 200, body: { id: NEW_USER_ID, email: 'invitee@test.local' } }),
  }),
  // PATCH /profiles?id=eq.<new>  — the post-create profile sync.
  profilePatch: () => ({
    match: (url, m) => m === 'PATCH' && url.includes('/rest/v1/profiles?id=eq.' + NEW_USER_ID),
    respond: () => ({ status: 204, body: null }),
  }),
  membersInsert: () => ({
    match: (url, m) => m === 'POST' && url.includes('/rest/v1/company_members'),
    respond: () => ({ status: 201, body: null }),
  }),
};

// Helper — assert that the upstream side-effect endpoint was never
// touched. Applied to every rejection test as a regression guard.
function assertNoAdminCreateCall() {
  const adminCalls = (captured || []).filter(c => /\/auth\/v1\/admin\/users$/.test(c.url));
  assert.equal(
    adminCalls.length, 0,
    'auth.js called /auth/v1/admin/users BEFORE all validation passed. ' +
    'Captured calls: ' + JSON.stringify((captured || []).map(c => c.url))
  );
}

// ── tests ──────────────────────────────────────────────────────────

describe('/auth/invite — auth gate (regression: no upstream create until all checks pass)', () => {

  it('rejects missing Bearer token with 401', async () => {
    installFetchMock([]);
    try {
      const res = await authMod.handler(makeEvent({ token: null, body: { email: 'x@y.z' } }));
      assert.equal(res.statusCode, 401);
      const j = JSON.parse(res.body);
      assert.match(j.error, /Authentication required/i);
      assertNoAdminCreateCall();
      assert.equal(captured.length, 0, 'no upstream calls when token absent');
    } finally { uninstallFetchMock(); }
  });

  it('rejects token that Supabase Auth rejects with 401', async () => {
    installFetchMock([r.authRejected()]);
    try {
      const res = await authMod.handler(makeEvent({ body: { email: 'x@y.z' } }));
      assert.equal(res.statusCode, 401);
      const j = JSON.parse(res.body);
      assert.match(j.error, /Invalid token/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects valid token whose profile is missing entirely (403 admin_only)', async () => {
    installFetchMock([r.authOK(), r.profile(null)]);
    try {
      const res = await authMod.handler(makeEvent({ body: { email: 'x@y.z' } }));
      assert.equal(res.statusCode, 403);
      const j = JSON.parse(res.body);
      assert.equal(j.code, 'admin_only');
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-admin caller with 403 admin_only', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_NON_ADMIN)]);
    try {
      const res = await authMod.handler(makeEvent({ body: { email: 'x@y.z' } }));
      assert.equal(res.statusCode, 403);
      const j = JSON.parse(res.body);
      assert.equal(j.code, 'admin_only');
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects admin caller with no company_id (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_NO_TEN)]);
    try {
      const res = await authMod.handler(makeEvent({ body: { email: 'x@y.z' } }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /no company_id/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects malformed JSON body (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({ body: '{not json' }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /Invalid JSON/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unexpected body key like is_super_user (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'x@y.z', role: 'Clinical', is_super_user: true },
      }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /Unexpected body key.*is_super_user/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unexpected body key like is_admin (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'x@y.z', is_admin: true },
      }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /Unexpected body key.*is_admin/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects missing email (400) — regression guard', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({ body: { role: 'Clinical' } }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /email required/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unknown role (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'x@y.z', role: 'GodMode' },
      }));
      assert.equal(res.statusCode, 400);
      const j = JSON.parse(res.body);
      assert.match(j.error, /role must be/i);
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects body.company_id pointing at a different tenant (403 cross_tenant)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_ADMIN_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'x@y.z', role: 'Clinical', company_id: TENANT_B },
      }));
      assert.equal(res.statusCode, 403);
      const j = JSON.parse(res.body);
      assert.equal(j.code, 'cross_tenant');
      assertNoAdminCreateCall();
    } finally { uninstallFetchMock(); }
  });
});

describe('/auth/invite — happy path', () => {

  it('accepts admin caller, body omits company_id → forces caller\'s tenant; 200', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_ADMIN_IN_A),
      r.adminCreateOK(),
      r.profilePatch(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'invitee@test.local', role: 'Clinical' },
      }));
      assert.equal(res.statusCode, 200);
      const j = JSON.parse(res.body);
      assert.equal(j.success, true);
      assert.equal(j.user_id, NEW_USER_ID);

      // Confirm the upstream admin-create call carried the caller's
      // tenant in user_metadata, not the body's (which was empty).
      const createCall = captured.find(c => /\/auth\/v1\/admin\/users$/.test(c.url));
      assert.ok(createCall, '/auth/v1/admin/users was not called');
      const payload = JSON.parse(createCall.opts.body);
      assert.equal(payload.user_metadata.company_id, TENANT_A);
      assert.equal(payload.user_metadata.role, 'Clinical');

      // Confirm company_members insert used caller's tenant.
      const memCall = captured.find(c => /\/rest\/v1\/company_members/.test(c.url));
      assert.ok(memCall, '/rest/v1/company_members was not called');
      const memPayload = JSON.parse(memCall.opts.body);
      assert.equal(memPayload.company_id, TENANT_A);
      assert.equal(memPayload.user_id, NEW_USER_ID);
      assert.equal(memPayload.role, 'Clinical');
    } finally { uninstallFetchMock(); }
  });

  it('accepts admin caller, body.company_id matches caller\'s tenant; 200', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_ADMIN_IN_A),
      r.adminCreateOK(),
      r.profilePatch(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'invitee@test.local', role: 'Non-Clinical', company_id: TENANT_A },
      }));
      assert.equal(res.statusCode, 200);
      const j = JSON.parse(res.body);
      assert.equal(j.success, true);
    } finally { uninstallFetchMock(); }
  });

  it('defaults to role=staff when role is omitted; 200', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_ADMIN_IN_A),
      r.adminCreateOK(),
      r.profilePatch(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { email: 'invitee@test.local' },
      }));
      assert.equal(res.statusCode, 200);
      const createCall = captured.find(c => /\/auth\/v1\/admin\/users$/.test(c.url));
      const payload = JSON.parse(createCall.opts.body);
      assert.equal(payload.user_metadata.role, 'staff');
    } finally { uninstallFetchMock(); }
  });
});
