// tests/analyzeRoute.test.js
//
// Tests for netlify/functions/_lib/routes/analyze.js — the
// correction-analyzer Anthropic proxy. Distinct from /triage in
// two important ways:
//
//   1. The model allowlist EXCLUDES Opus by design — running diff
//      summarization on Opus would cost >10x more than Sonnet for
//      no quality improvement on this task. If Opus accidentally
//      got added to the allowlist, the bill would surface
//      asynchronously through our usage dashboards. A test pins
//      the deny.
//
//   2. The max_tokens cap is 1024 (vs /triage's 4096) — diff
//      summaries don't need long outputs and a cap regression here
//      is also a budget-burn vector.
//
// Auth + JSON body validation mirror /triage and are tested with
// the same shape.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-key';

const analyze = require('../netlify/functions/_lib/routes/analyze.js');

const realFetch = global.fetch;
let captured = null;

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

function makeEvent({ method = 'POST', body = null, token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path: '/.netlify/functions/kb/analyze',
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: token ? { authorization: 'Bearer ' + token } : {},
  };
}

function decode(res) {
  let body = res.body;
  try { body = JSON.parse(res.body); } catch (e) { /* leave as string */ }
  return { status: res.statusCode, body };
}

const anthropicOK = { id: 'msg_x', content: [{ type: 'text', text: 'analyzer note' }], usage: { input_tokens: 100, output_tokens: 50 } };

function defaultRoutes(overrides = {}) {
  return [
    {
      match: (url) => url.includes('/auth/v1/user'),
      respond: () => overrides.authResponse || { status: 200, body: { id: 'user-1', email: 't@x' } },
    },
    {
      match: (url) => url.includes('api.anthropic.com/v1/messages'),
      respond: () => overrides.anthropicResponse || { status: 200, body: anthropicOK },
    },
  ];
}

describe('analyze route — auth', () => {
  it('rejects missing bearer token with 401', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ token: null, body: { model: 'claude-haiku-4-5' } }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 401);
    assert.match(body.error, /Authentication required/);
  });

  it('rejects when Supabase rejects the bearer token', async () => {
    installFetchMock(defaultRoutes({ authResponse: { status: 401, body: { error: 'invalid jwt' } } }));
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 401);
  });
});

describe('analyze route — body validation', () => {
  it('rejects invalid JSON body with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: '{ not json' }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 400);
    assert.match(body.error, /Invalid JSON/);
  });

  it('rejects missing model with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: {} }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 400);
    assert.match(body.error, /Unsupported model/);
  });
});

describe('analyze route — model allowlist', () => {
  it('accepts claude-haiku-4-5', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
  });

  it('accepts claude-sonnet-4-6', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-sonnet-4-6' } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
  });

  it('REJECTS claude-opus-4-7 — deliberate budget guard', async () => {
    // The triage proxy allows Opus. The analyze proxy MUST NOT —
    // this is the budget-control distinction between the two
    // endpoints. If this assertion ever fails, someone widened the
    // allowlist without thinking through the cost implication.
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-opus-4-7' } }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 400, 'Opus must be denied on /analyze');
    assert.match(body.error, /Unsupported model/);
  });

  it('rejects unknown model with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: { model: 'gpt-4' } }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 400);
  });
});

describe('analyze route — max_tokens handling', () => {
  it('defaults max_tokens to 200 when missing', async () => {
    installFetchMock(defaultRoutes());
    await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.equal(sent.max_tokens, 200);
  });

  it('defaults max_tokens to 200 when zero or negative', async () => {
    installFetchMock(defaultRoutes());
    await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5', max_tokens: 0 } }));
    const c0 = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.equal(c0.max_tokens, 200);
  });

  it('clamps max_tokens at 1024 (analyze cap is lower than triage)', async () => {
    installFetchMock(defaultRoutes());
    await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5', max_tokens: 999_999 } }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.equal(sent.max_tokens, 1024);
  });

  it('passes through a max_tokens within the cap', async () => {
    installFetchMock(defaultRoutes());
    await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5', max_tokens: 500 } }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.equal(sent.max_tokens, 500);
  });
});

describe('analyze route — upstream pass-through', () => {
  it('forwards Anthropic 200 body and status verbatim', async () => {
    installFetchMock(defaultRoutes());
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.content[0].text, 'analyzer note');
  });

  it('forwards Anthropic non-2xx status', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 529, body: { type: 'error', error: { type: 'overloaded' } } },
    }));
    const res = await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 529);
  });

  it('sends x-api-key and anthropic-version on the upstream call', async () => {
    installFetchMock(defaultRoutes());
    await analyze.handle(makeEvent({ body: { model: 'claude-haiku-4-5' } }));
    const call = captured.find(c => c.url.includes('api.anthropic.com'));
    uninstallFetchMock();
    assert.equal(call.opts.headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(call.opts.headers['anthropic-version'], '2023-06-01');
  });
});
