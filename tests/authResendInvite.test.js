// tests/authResendInvite.test.js
//
// End-to-end tests for POST /auth/resend-invite added in phase 1.5.
//
// This endpoint lets a super-user re-trigger the password-set email
// for a pending invitee (accepted_at IS NULL). It calls Supabase's
// /auth/v1/recover server-side; the email lands the user back at
// /accept-invite.html.
//
// Coverage:
//   * Bearer token required (401).
//   * Token verified with Supabase Auth (401 if rejected).
//   * Non-super-user refused (403 super_user_only).
//   * Caller without company_id refused (400).
//   * Body must be valid JSON (400).
//   * Body key allowlist — only user_id accepted (400 on others).
//   * Missing user_id refused (400).
//   * Target not in caller's tenant → 404.
//   * Target already accepted → 400 (code: already_accepted).
//   * Target has no email on file → 400.
//   * Happy path: 200, /auth/v1/recover called with target's email
//     (NOT a body-supplied email — that protection lives in the
//     allowlist + tenant scope, but the test confirms the call
//     payload regardless).
//
// Regression guard: /auth/v1/recover MUST NOT be called until every
// gate passes.

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
function makeEvent({ method = 'POST', body = null, token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path: '/.netlify/functions/auth/resend-invite',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const PROFILE_SUPER_IN_A   = { is_super_user: true,  company_id: TENANT_A };
const PROFILE_NON_SUPER    = { is_super_user: false, company_id: TENANT_A };
const PROFILE_SUPER_NO_TEN = { is_super_user: true,  company_id: null };

const TARGET_PENDING  = { id: TARGET_ID, email: 'pending@test.local', accepted_at: null };
const TARGET_ACCEPTED = { id: TARGET_ID, email: 'active@test.local',  accepted_at: '2026-05-15T10:00:00Z' };
const TARGET_NO_EMAIL = { id: TARGET_ID, email: null,                 accepted_at: null };

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
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + CALLER_ID),
    respond: () => ({ status: 200, body: prof ? [prof] : [] }),
  }),
  targetProfile: (target) => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + TARGET_ID),
    respond: () => ({ status: 200, body: target ? [target] : [] }),
  }),
  recoverOK: () => ({
    match: (url, m) => m === 'POST' && url.endsWith('/auth/v1/recover'),
    respond: () => ({ status: 200, body: {} }),
  }),
};

function assertNoRecoverCall() {
  const calls = (captured || []).filter(c => /\/auth\/v1\/recover$/.test(c.url));
  assert.equal(calls.length, 0,
    '/auth/v1/recover called before all gates passed. Captured: ' +
    JSON.stringify((captured || []).map(c => c.url)));
}

const VALID_BODY = { user_id: TARGET_ID };

describe('/auth/resend-invite — auth gate (regression: no recover until all checks pass)', () => {

  it('rejects missing Bearer token with 401', async () => {
    installFetchMock([]);
    try {
      const res = await authMod.handler(makeEvent({ token: null, body: VALID_BODY }));
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /Authentication required/i);
      assertNoRecoverCall();
      assert.equal(captured.length, 0);
    } finally { uninstallFetchMock(); }
  });

  it('rejects token Supabase rejects with 401', async () => {
    installFetchMock([r.authRejected()]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 401);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-super-user caller (403 super_user_only)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_NON_SUPER)]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, 'super_user_only');
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects super-user with no company_id (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_SUPER_NO_TEN)]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /no company_id/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects malformed JSON body (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({ body: '{not json' }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Invalid JSON/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unexpected body key (email — server reads email from profile, not body) (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { user_id: TARGET_ID, email: 'hostile@example.com' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Unexpected body key.*email/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects missing user_id (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({ body: {} }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /user_id required/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects target not found in caller tenant (404)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.targetProfile(null),
    ]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 404);
      assert.match(JSON.parse(res.body).error, /not found in your tenant/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects target that has already accepted (400 already_accepted)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.targetProfile(TARGET_ACCEPTED),
    ]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).code, 'already_accepted');
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects target with no email on file (400)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.targetProfile(TARGET_NO_EMAIL),
    ]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /no email/i);
      assertNoRecoverCall();
    } finally { uninstallFetchMock(); }
  });
});

describe('/auth/resend-invite — happy path', () => {

  it('200; /auth/v1/recover called with the target profile email (NOT body-supplied)', async () => {
    installFetchMock([
      r.authOK(),
      r.callerProfile(PROFILE_SUPER_IN_A),
      r.targetProfile(TARGET_PENDING),
      r.recoverOK(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 200);
      const j = JSON.parse(res.body);
      assert.equal(j.success, true);
      assert.equal(j.email, TARGET_PENDING.email);

      const recoverCall = captured.find(c => /\/auth\/v1\/recover$/.test(c.url));
      assert.ok(recoverCall, '/auth/v1/recover was not called');
      const payload = JSON.parse(recoverCall.opts.body);
      assert.equal(payload.email, TARGET_PENDING.email,
        'recover payload must use profile email, not anything else');
    } finally { uninstallFetchMock(); }
  });
});
