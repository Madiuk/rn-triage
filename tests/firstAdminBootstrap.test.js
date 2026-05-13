// tests/firstAdminBootstrap.test.js
//
// Unit tests for maybeBootstrapFirstAdmin in netlify/functions/_lib/auth.js.
//
// The helper auto-promotes a signed-in user to is_admin + is_super_user
// when their tenant has zero existing super-users. It closes a real
// onboarding gap from v0.4.1: migration 0010 required a manual UPDATE
// to elevate the first user, which Brad missed and surfaced as "I
// thought I'd be the admin/super user?" The bootstrap eliminates that
// manual step for every future tenant.
//
// Behavioral coverage:
//   1. Already super-user → no-op, returns false.
//   2. Profile null → no-op, returns false.
//   3. No company_id on profile → no-op, returns false.
//   4. Tenant already has a super-user → no-op, returns false; profile
//      flags NOT mutated.
//   5. Tenant has zero super-users → PROMOTES (PATCH /profiles),
//      mutates `profile` in place, writes audit_log, returns true.
//   6. Super-user check returns non-ok → FAILS CLOSED (returns false,
//      no promote, no mutation). "Don't promote on a failed lookup"
//      is the load-bearing safety invariant the function's header
//      documents.
//   7. Promote PATCH returns non-ok → returns false, profile NOT
//      mutated. Caller sees the original flags and can decide how
//      to surface the failure.
//
// Mock pattern mirrors triageProxy.test.js and authInviteAuth.test.js.

process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const { maybeBootstrapFirstAdmin } = require('../netlify/functions/_lib/auth.js');

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

// Helpers for the three upstream calls the function makes.
const r = {
  checkSuperUserExists: (existsCount) => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?company_id=eq.') && url.includes('is_super_user=eq.true'),
    respond: () => ({ status: 200, body: existsCount > 0 ? [{ id: 'existing-su' }] : [] }),
  }),
  checkSuperUserFails: () => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?company_id=eq.') && url.includes('is_super_user=eq.true'),
    respond: () => ({ status: 500, body: { error: 'simulated lookup failure' } }),
  }),
  promoteOK: (userId) => ({
    match: (url, m) => m === 'PATCH' && url.includes('/rest/v1/profiles?id=eq.' + userId),
    respond: () => ({ status: 204, body: null }),
  }),
  promoteFails: (userId) => ({
    match: (url, m) => m === 'PATCH' && url.includes('/rest/v1/profiles?id=eq.' + userId),
    respond: () => ({ status: 500, body: { error: 'simulated promote failure' } }),
  }),
  auditInsert: () => ({
    match: (url, m) => m === 'POST' && url.includes('/rest/v1/audit_log'),
    respond: () => ({ status: 201, body: null }),
  }),
};

const USER_ID = '11111111-1111-1111-1111-111111111111';
const TENANT  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function newProfile(overrides) {
  return Object.assign({
    id: USER_ID,
    is_admin: false,
    is_super_user: false,
    company_id: TENANT,
    full_name: 'Test User',
  }, overrides || {});
}

const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': 'test-service-key',
  'Authorization': 'Bearer test-service-key',
};

// Helper to count calls that match a substring + method, so tests
// can assert "we never even tried to promote" or "we never wrote
// audit_log."
function callsMatching(predicate) {
  return (captured || []).filter(c => predicate(c.url, (c.opts && c.opts.method) || 'GET'));
}

describe('maybeBootstrapFirstAdmin — guard clauses (no-op fast paths)', () => {

  it('returns false when profile is already super-user (no upstream calls)', async () => {
    installFetchMock([]);
    try {
      const profile = newProfile({ is_super_user: true });
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, false);
      assert.equal(captured.length, 0, 'no upstream calls when already super-user');
      // Flags unchanged.
      assert.equal(profile.is_super_user, true);
      assert.equal(profile.is_admin, false);
    } finally { uninstallFetchMock(); }
  });

  it('returns false when profile is null', async () => {
    installFetchMock([]);
    try {
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, null, HEADERS);
      assert.equal(result, false);
      assert.equal(captured.length, 0);
    } finally { uninstallFetchMock(); }
  });

  it('returns false when user has no id', async () => {
    installFetchMock([]);
    try {
      const profile = newProfile();
      const result = await maybeBootstrapFirstAdmin({}, profile, HEADERS);
      assert.equal(result, false);
      assert.equal(captured.length, 0);
    } finally { uninstallFetchMock(); }
  });

  it('returns false when profile has no company_id', async () => {
    installFetchMock([]);
    try {
      const profile = newProfile({ company_id: null });
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, false);
      assert.equal(captured.length, 0, 'no upstream calls when company_id is null');
      assert.equal(profile.is_admin, false);
      assert.equal(profile.is_super_user, false);
    } finally { uninstallFetchMock(); }
  });
});

describe('maybeBootstrapFirstAdmin — tenant already has a super-user', () => {

  it('returns false; does NOT call promote PATCH; profile unchanged', async () => {
    installFetchMock([r.checkSuperUserExists(1)]);
    try {
      const profile = newProfile();
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, false);

      // Lookup happened; promote did NOT.
      const lookups = callsMatching((u, m) => m === 'GET' && u.includes('is_super_user=eq.true'));
      assert.equal(lookups.length, 1, 'expected exactly one lookup');
      const promotes = callsMatching((u, m) => m === 'PATCH' && u.includes('/rest/v1/profiles?id=eq.'));
      assert.equal(promotes.length, 0, 'must not promote when a super-user already exists');

      assert.equal(profile.is_admin, false);
      assert.equal(profile.is_super_user, false);
    } finally { uninstallFetchMock(); }
  });
});

describe('maybeBootstrapFirstAdmin — happy path (no super-user yet → promote)', () => {

  it('PATCHes profile, writes audit_log, mutates in-memory profile, returns true', async () => {
    installFetchMock([
      r.checkSuperUserExists(0),
      r.promoteOK(USER_ID),
      r.auditInsert(),
    ]);
    try {
      const profile = newProfile();
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, true);

      // In-memory mutation so the response reflects new state without
      // another round-trip. The header comment promises this; the test
      // pins the promise.
      assert.equal(profile.is_admin, true);
      assert.equal(profile.is_super_user, true);

      // PATCH carried the expected body.
      const promoteCall = callsMatching((u, m) => m === 'PATCH' && u.includes('/rest/v1/profiles?id=eq.' + USER_ID))[0];
      assert.ok(promoteCall, 'expected a promote PATCH call');
      const body = JSON.parse(promoteCall.opts.body);
      assert.equal(body.is_admin, true);
      assert.equal(body.is_super_user, true);

      // Audit log was attempted (fire-and-forget; we just check the
      // POST went out and carried the right event_type).
      // Audit is fire-and-forget; await a microtask so the promise lands.
      await new Promise(setImmediate);
      const auditCalls = callsMatching((u, m) => m === 'POST' && u.includes('/rest/v1/audit_log'));
      assert.equal(auditCalls.length, 1, 'expected an audit_log insert');
      const auditBody = JSON.parse(auditCalls[0].opts.body);
      assert.equal(auditBody.event_type, 'auth.first_admin_bootstrap');
      assert.equal(auditBody.actor_id, USER_ID);
      assert.equal(auditBody.company_id, TENANT);
    } finally { uninstallFetchMock(); }
  });
});

describe('maybeBootstrapFirstAdmin — failure paths (fail closed)', () => {

  it('returns false on super-user lookup failure; does NOT promote', async () => {
    installFetchMock([r.checkSuperUserFails()]);
    try {
      const profile = newProfile();
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, false, 'must fail closed on a failed lookup');

      const promotes = callsMatching((u, m) => m === 'PATCH' && u.includes('/rest/v1/profiles?id=eq.'));
      assert.equal(promotes.length, 0, 'fail-closed means we do not attempt the promote');

      assert.equal(profile.is_admin, false);
      assert.equal(profile.is_super_user, false);
    } finally { uninstallFetchMock(); }
  });

  it('returns false when promote PATCH fails; profile NOT mutated', async () => {
    installFetchMock([
      r.checkSuperUserExists(0),
      r.promoteFails(USER_ID),
      // No audit route mocked — if the function tries to audit on a
      // failed promote (which it shouldn't, per the function's flow),
      // the unmocked-fetch error would surface here as a test failure.
    ]);
    try {
      const profile = newProfile();
      const result = await maybeBootstrapFirstAdmin({ id: USER_ID }, profile, HEADERS);
      assert.equal(result, false, 'must return false when promote fails');

      // Critically: in-memory profile must NOT reflect the new state,
      // because the response would lie about the user's permissions.
      assert.equal(profile.is_admin, false);
      assert.equal(profile.is_super_user, false);
    } finally { uninstallFetchMock(); }
  });
});
