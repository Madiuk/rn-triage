// tests/adminUsersUpdateRole.test.js
//
// Phase-1.5 contract tests for the prefix / suffix additions to
// POST /admin/users action=update_role (in _lib/routes/admin.js).
//
// Existing fields (role, title, is_admin, is_super_user) are
// integration-tested via real deploys, per the established
// convention in admin-events.test.js. This file pins the new
// fields' validation + back-compat semantics:
//
//   * suffix mirrors into title on every write (so the mig-0017
//     snapshot rails — query_history.user_title, review_requests.
//     resolved_by_title — keep filling in even though the API
//     surface renamed the column).
//   * suffix=null clears BOTH suffix and title.
//   * Length bounds: prefix ≤ 8, suffix ≤ 24.
//   * The PATCH target is tenant-scoped (no caller body can reach
//     across tenants — same protection as the existing fields).

process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const adminMod = require('../netlify/functions/_lib/routes/admin.js');

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
    path: '/.netlify/functions/kb/admin/users',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const CALLER_ID = 'caller-id-1';
const TARGET_ID = 'target-id-1';
const TENANT    = 'tenant-1';

const PROFILE_CALLER_ADMIN_SUPER = {
  id: CALLER_ID, company_id: TENANT,
  role: 'Clinical', title: 'RN',
  is_admin: true, is_super_user: true,
  full_name: 'Admin Super',
};

const r = {
  authOK: () => ({
    match: (url, m) => m === 'GET' && url.endsWith('/auth/v1/user'),
    respond: () => ({ status: 200, body: { id: CALLER_ID, email: 'admin@test.local' } }),
  }),
  callerProfile: () => ({
    match: (url, m) => m === 'GET' && url.includes('/rest/v1/profiles?id=eq.' + CALLER_ID),
    respond: () => ({ status: 200, body: [PROFILE_CALLER_ADMIN_SUPER] }),
  }),
  // The PATCH target — captures the body so tests can inspect it.
  patchOK: () => ({
    match: (url, m) =>
      m === 'PATCH' &&
      url.includes('/rest/v1/profiles?id=eq.' + TARGET_ID) &&
      url.includes('company_id=eq.' + TENANT),
    respond: (url, opts) => ({ status: 200, body: [{ id: TARGET_ID }] }),
  }),
};

function findPatchBody() {
  const call = (captured || []).find(c =>
    c.opts && c.opts.method === 'PATCH' &&
    c.url.includes('/rest/v1/profiles?id=eq.' + TARGET_ID));
  return call ? JSON.parse(call.opts.body) : null;
}

// ── tests ──────────────────────────────────────────────────────────

describe('/admin/users update_role — suffix back-compat (mig 0017 + 0030)', () => {

  it('writing suffix also writes title (so snapshot rails keep filling)', async () => {
    installFetchMock([r.authOK(), r.callerProfile(), r.patchOK()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, suffix: 'NP' },
      }));
      assert.equal(res.statusCode, 200);
      const patch = findPatchBody();
      assert.ok(patch, 'PATCH was not made');
      assert.equal(patch.suffix, 'NP');
      assert.equal(patch.title,  'NP', 'title must mirror suffix for back-compat');
    } finally { uninstallFetchMock(); }
  });

  it('suffix=null clears BOTH suffix and title', async () => {
    installFetchMock([r.authOK(), r.callerProfile(), r.patchOK()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, suffix: null },
      }));
      assert.equal(res.statusCode, 200);
      const patch = findPatchBody();
      assert.equal(patch.suffix, null);
      assert.equal(patch.title,  null);
    } finally { uninstallFetchMock(); }
  });

  it('trims whitespace and treats empty-after-trim as null', async () => {
    installFetchMock([r.authOK(), r.callerProfile(), r.patchOK()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, suffix: '   ' },
      }));
      assert.equal(res.statusCode, 200);
      const patch = findPatchBody();
      assert.equal(patch.suffix, null);
      assert.equal(patch.title,  null);
    } finally { uninstallFetchMock(); }
  });
});

describe('/admin/users update_role — prefix', () => {

  it('accepts a valid prefix', async () => {
    installFetchMock([r.authOK(), r.callerProfile(), r.patchOK()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, prefix: 'Dr.' },
      }));
      assert.equal(res.statusCode, 200);
      const patch = findPatchBody();
      assert.equal(patch.prefix, 'Dr.');
      // Prefix doesn't touch title (only suffix does — they're different
      // semantically: prefix is the salutation, suffix is the credential).
      assert.equal('title' in patch, false, 'prefix must NOT touch title');
    } finally { uninstallFetchMock(); }
  });

  it('prefix=null clears the column', async () => {
    installFetchMock([r.authOK(), r.callerProfile(), r.patchOK()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, prefix: null },
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(findPatchBody().prefix, null);
    } finally { uninstallFetchMock(); }
  });
});

describe('/admin/users update_role — length bounds', () => {

  it('rejects prefix > 8 chars (400) before any PATCH', async () => {
    installFetchMock([r.authOK(), r.callerProfile()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, prefix: 'Honorable' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /prefix.*8 characters/i);
      const patched = (captured || []).filter(c =>
        c.opts && c.opts.method === 'PATCH' &&
        c.url.includes('/rest/v1/profiles'));
      assert.equal(patched.length, 0, 'no PATCH must fire before validation passes');
    } finally { uninstallFetchMock(); }
  });

  it('rejects suffix > 24 chars (400) before any PATCH', async () => {
    installFetchMock([r.authOK(), r.callerProfile()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID,
                suffix: 'Pharm.D., FAAP, FACEP, MBA' },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /suffix.*24 characters/i);
      const patched = (captured || []).filter(c =>
        c.opts && c.opts.method === 'PATCH' &&
        c.url.includes('/rest/v1/profiles'));
      assert.equal(patched.length, 0, 'no PATCH must fire before validation passes');
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-string prefix (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, prefix: 42 },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /prefix must be a string/i);
    } finally { uninstallFetchMock(); }
  });

  it('rejects non-string suffix (400)', async () => {
    installFetchMock([r.authOK(), r.callerProfile()]);
    try {
      const res = await adminMod.handle(makeEvent({
        body: { action: 'update_role', user_id: TARGET_ID, suffix: 42 },
      }));
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /suffix must be a string/i);
    } finally { uninstallFetchMock(); }
  });
});
