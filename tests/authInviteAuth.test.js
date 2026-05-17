// tests/authInviteAuth.test.js
//
// End-to-end tests for POST /auth/invite in netlify/functions/auth.js
// after the migration 0030 rewrite — super-user-only, email-sending
// invite that lands the new account on /accept-invite.html.
//
// History — earlier this endpoint had NO caller auth (highest-severity
// finding in RELAI_VALIDATION_AUDIT.md). Then is_admin gate, no email
// sent (admin had to manually share the sign-in URL). Now: is_super_user
// gate AND the upstream call is /auth/v1/invite (which triggers the
// Supabase invite email) instead of /auth/v1/admin/users (silent
// confirmed-user create).
//
// Coverage:
//   * Bearer token required (401).
//   * Token verified with Supabase Auth (401 if rejected).
//   * Profile lookup; non-super-user refused (403, code=super_user_only).
//   * Super-user without company_id refused (400).
//   * Body must be valid JSON (400).
//   * Body key allowlist — privileged keys, tenant overrides, and the
//     legacy `title` key all refused (400).
//   * Required-field shape: email, first_name, last_name, role.
//   * Length bounds: prefix ≤ 8, suffix ≤ 24.
//   * role must be in {Clinical, Non-Clinical} (legacy 'staff' refused).
//   * Happy path: 200, upstream /auth/v1/invite called with
//     tenant-scoped metadata (caller's company_id, never body's),
//     profile inserted with invited_at set + accepted_at null,
//     title back-compat populated from suffix.
//
// Side-effect regression guard (applied to every rejection test):
// /auth/v1/invite MUST NOT be called until all gates pass.

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
const NEW_USER_ID = '22222222-2222-2222-2222-222222222222';

const PROFILE_SUPER_IN_A   = { is_super_user: true,  company_id: TENANT_A };
const PROFILE_NON_SUPER    = { is_super_user: false, company_id: TENANT_A };
const PROFILE_SUPER_NO_TEN = { is_super_user: true,  company_id: null };

const r = {
  authOK: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 200, body: { id: CALLER_ID, email: 'super@test.local' } }),
  }),
  authRejected: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 401, body: { error: 'Invalid token' } }),
  }),
  // Profile lookup uses select=is_super_user,company_id — match on the
  // id filter so the test isn't coupled to the exact select list.
  profile: (prof) => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + CALLER_ID),
    respond: () => ({ status: 200, body: prof ? [prof] : [] }),
  }),
  inviteOK: () => ({
    match: (url, m) => m === 'POST' && url.endsWith('/auth/v1/invite'),
    respond: () => ({ status: 200, body: { id: NEW_USER_ID, email: 'invitee@test.local' } }),
  }),
  profileInsert: () => ({
    match: (url, m) => m === 'POST' && url.endsWith('/rest/v1/profiles'),
    respond: () => ({ status: 201, body: null }),
  }),
  membersInsert: () => ({
    match: (url, m) => m === 'POST' && url.includes('/rest/v1/company_members'),
    respond: () => ({ status: 201, body: null }),
  }),
};

// Helper — assert that the upstream invite-email endpoint was never
// touched. Applied to every rejection test as a regression guard.
function assertNoInviteCall() {
  const inviteCalls = (captured || []).filter(c => /\/auth\/v1\/invite$/.test(c.url));
  assert.equal(
    inviteCalls.length, 0,
    'auth.js called /auth/v1/invite BEFORE all validation passed. ' +
    'Captured calls: ' + JSON.stringify((captured || []).map(c => c.url))
  );
}

// Baseline valid invite body; tests mutate or omit fields from this.
const VALID_BODY = {
  email: 'invitee@test.local',
  first_name: 'Alex',
  last_name: 'Lee',
  role: 'Clinical',
};

// ── tests ──────────────────────────────────────────────────────────

describe('/auth/invite — auth gate (regression: no upstream invite until all checks pass)', () => {

  it('rejects missing Bearer token with 401', async () => {
    installFetchMock([]);
    try {
      const res = await authMod.handler(makeEvent({ token: null, body: VALID_BODY }));
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /Authentication required/i);
      assertNoInviteCall();
      assert.equal(captured.length, 0, 'no upstream calls when token absent');
    } finally { uninstallFetchMock(); }
  });

  it('rejects token that Supabase Auth rejects with 401', async () => {
    installFetchMock([r.authRejected()]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error, /Invalid token/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects valid token whose profile is missing entirely (403 super_user_only)', async () => {
    installFetchMock([r.authOK(), r.profile(null)]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, 'super_user_only');
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-super-user caller with 403 super_user_only', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_NON_SUPER)]);
    try {
      const res = await(authMod.handler(makeEvent({ body: VALID_BODY })));
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).code, 'super_user_only');
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects super-user with no company_id (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_NO_TEN)]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /no company_id/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects malformed JSON body (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({ body: '{not json' }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Invalid JSON/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unexpected body key (is_super_user) (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, is_super_user: true },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Unexpected body key.*is_super_user/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unexpected body key (is_admin) (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, is_admin: true },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Unexpected body key.*is_admin/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects body.company_id (tenant override; no longer in allowlist) (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, company_id: 'whatever' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Unexpected body key.*company_id/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects body.title (legacy field name; replaced by suffix) (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, title: 'RN' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Unexpected body key.*title/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects missing email (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const body = { ...VALID_BODY }; delete body.email;
      const res = await authMod.handler(makeEvent({ body }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /email/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects missing first_name (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const body = { ...VALID_BODY }; delete body.first_name;
      const res = await authMod.handler(makeEvent({ body }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /first_name/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects missing last_name (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const body = { ...VALID_BODY }; delete body.last_name;
      const res = await authMod.handler(makeEvent({ body }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /last_name/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects unknown role (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, role: 'GodMode' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /role must be/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects legacy role=staff (no longer accepted) (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, role: 'staff' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /role must be/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects prefix > 8 chars (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, prefix: 'Honorable' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /prefix.*8 characters/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });

  it('rejects suffix > 24 chars (400)', async () => {
    installFetchMock([r.authOK(), r.profile(PROFILE_SUPER_IN_A)]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, suffix: 'Pharm.D., FAAP, FACEP, MBA' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /suffix.*24 characters/i);
      assertNoInviteCall();
    } finally { uninstallFetchMock(); }
  });
});

describe('/auth/invite — happy path', () => {

  it('accepts well-formed body, calls /auth/v1/invite with caller-scoped metadata, inserts profile with invited_at set', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_SUPER_IN_A),
      r.inviteOK(),
      r.profileInsert(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, prefix: 'Dr.', suffix: 'MD' },
      }));
      assert.equal(res.statusCode, 200);
      const j = JSON.parse(res.body);
      assert.equal(j.success, true);
      assert.equal(j.user_id, NEW_USER_ID);

      // The invite call should hit /auth/v1/invite (which sends the
      // email), NOT /auth/v1/admin/users (which silently confirms).
      const inviteCall = captured.find(c => /\/auth\/v1\/invite$/.test(c.url));
      assert.ok(inviteCall, '/auth/v1/invite was not called');
      const invitePayload = JSON.parse(inviteCall.opts.body);
      assert.equal(invitePayload.email, 'invitee@test.local');
      assert.equal(invitePayload.data.company_id, TENANT_A);
      assert.equal(invitePayload.data.role, 'Clinical');
      assert.equal(invitePayload.data.first_name, 'Alex');
      assert.equal(invitePayload.data.last_name, 'Lee');
      assert.equal(invitePayload.data.full_name, 'Alex Lee');
      assert.equal(invitePayload.data.prefix, 'Dr.');
      assert.equal(invitePayload.data.suffix, 'MD');

      // Regression: the legacy admin/users endpoint must NOT be touched.
      const adminCalls = captured.filter(c => /\/auth\/v1\/admin\/users$/.test(c.url));
      assert.equal(adminCalls.length, 0, 'old admin/users endpoint must not be used');

      // Profile insert: invited_at set, accepted_at null, title carries
      // the suffix value for back-compat with mig-0017 snapshot rails.
      const profileCall = captured.find(c =>
        /\/rest\/v1\/profiles$/.test(c.url) && (c.opts && c.opts.method === 'POST'));
      assert.ok(profileCall, '/rest/v1/profiles insert was not called');
      const profileBody = JSON.parse(profileCall.opts.body);
      assert.equal(profileBody.id, NEW_USER_ID);
      assert.equal(profileBody.company_id, TENANT_A);
      assert.equal(profileBody.role, 'Clinical');
      assert.equal(profileBody.first_name, 'Alex');
      assert.equal(profileBody.last_name, 'Lee');
      assert.equal(profileBody.full_name, 'Alex Lee');
      assert.equal(profileBody.email, 'invitee@test.local');
      assert.equal(profileBody.prefix, 'Dr.');
      assert.equal(profileBody.suffix, 'MD');
      assert.equal(profileBody.title, 'MD', 'title back-compat populated from suffix');
      assert.ok(profileBody.invited_at, 'invited_at must be set on invite');
      assert.equal(profileBody.accepted_at, null, 'accepted_at must be null until /auth/accept');

      // company_members back-compat insert.
      const memCall = captured.find(c => /\/rest\/v1\/company_members/.test(c.url));
      assert.ok(memCall, '/rest/v1/company_members was not called');
      const memPayload = JSON.parse(memCall.opts.body);
      assert.equal(memPayload.company_id, TENANT_A);
      assert.equal(memPayload.user_id, NEW_USER_ID);
      assert.equal(memPayload.role, 'Clinical');
    } finally { uninstallFetchMock(); }
  });

  it('accepts Non-Clinical role', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_SUPER_IN_A),
      r.inviteOK(),
      r.profileInsert(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({
        body: { ...VALID_BODY, role: 'Non-Clinical' },
      }));
      assert.equal(res.statusCode, 200);
    } finally { uninstallFetchMock(); }
  });

  it('omits prefix/suffix from profile insert when not provided', async () => {
    installFetchMock([
      r.authOK(),
      r.profile(PROFILE_SUPER_IN_A),
      r.inviteOK(),
      r.profileInsert(),
      r.membersInsert(),
    ]);
    try {
      const res = await authMod.handler(makeEvent({ body: VALID_BODY }));
      assert.equal(res.statusCode, 200);
      const profileCall = captured.find(c =>
        /\/rest\/v1\/profiles$/.test(c.url) && (c.opts && c.opts.method === 'POST'));
      const profileBody = JSON.parse(profileCall.opts.body);
      assert.equal(profileBody.prefix, undefined, 'prefix omitted when not provided');
      assert.equal(profileBody.suffix, undefined, 'suffix omitted when not provided');
      assert.equal(profileBody.title, undefined, 'title omitted when no suffix provided');
    } finally { uninstallFetchMock(); }
  });
});
