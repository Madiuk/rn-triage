// tests/triageProxy.test.js
//
// End-to-end tests for netlify/functions/triage.js — the Anthropic
// proxy that every classification request flows through. Before
// this, every guard in that file (method allowlist, auth, model
// allowlist, max_tokens cap, error pass-through, malformed-upstream
// → 502, and the `_relai` telemetry envelope) was unverified. A
// regression that disabled the auth check or removed the model
// allowlist would only surface on production traffic — at which
// point arbitrary callers could drive Anthropic spend.
//
// We mock global.fetch so we can run the handler in Node without
// hitting Anthropic. The mock returns canned responses keyed off
// URL substring, mirroring the roleGates.test.js pattern.

// Env vars must be set BEFORE requiring the handler; triage.js
// reads SUPABASE_URL / SUPABASE_ANON_KEY / ANTHROPIC_API_KEY at
// module load time.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-key';

const triage = require('../netlify/functions/triage.js');

// ─────────────────────────────────────────────────────────────────
// fetch mock — install + uninstall around each test so global state
// can't leak between tests. The runner already serializes tests, so
// no race risk on the global.fetch slot.
// ─────────────────────────────────────────────────────────────────

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
function uninstallFetchMock() { global.fetch = realFetch; }

function makeResponse({ status = 200, body = null, headers = {} }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
  };
}

function makeEvent({ method = 'POST', body = null, token = 'fake-bearer-token' } = {}) {
  return {
    httpMethod: method,
    path: '/.netlify/functions/triage',
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: token ? { authorization: 'Bearer ' + token } : {},
  };
}

function decode(res) {
  let body = res.body;
  try { body = JSON.parse(res.body); } catch (e) { /* leave as string */ }
  return { status: res.statusCode, body, headers: res.headers || {} };
}

// Canned Anthropic 200 response shape.
function anthropicOK(extra = {}) {
  return Object.assign({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '{"urgency":"routine","draft_response":"hi"}' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    },
  }, extra);
}

// Default route set — auth passes, Anthropic returns a clean 200.
function defaultRoutes(overrides = {}) {
  return [
    {
      match: (url) => url.includes('/auth/v1/user'),
      respond: () => overrides.authResponse || { status: 200, body: { id: 'user-1', email: 't@x' } },
    },
    {
      match: (url) => url.includes('api.anthropic.com/v1/messages'),
      respond: () => overrides.anthropicResponse || { status: 200, body: anthropicOK() },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('triage proxy — method allowlist', () => {
  it('rejects GET with 405', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({ method: 'GET' }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 405);
  });
});

describe('triage proxy — auth', () => {
  it('rejects missing bearer token with 401', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({ token: null, body: { model: 'claude-sonnet-4-6' } }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 401);
    assert.match(body.error, /Authentication required/);
  });

  it('rejects when Supabase rejects the bearer token', async () => {
    installFetchMock(defaultRoutes({ authResponse: { status: 401, body: { error: 'invalid jwt' } } }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6' } }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 401);
  });

  it('rejects when Supabase returns a user without an id', async () => {
    // Defense against a degraded Supabase response that 200s but
    // returns an empty body — earlier code accepted any 200 as
    // "authenticated."
    installFetchMock(defaultRoutes({ authResponse: { status: 200, body: {} } }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6' } }));
    uninstallFetchMock();
    assert.equal(decode(res).status, 401);
  });
});

describe('triage proxy — body / model validation', () => {
  it('rejects invalid JSON body with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({ body: '{ not json' }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 400);
    assert.match(body.error, /Invalid JSON/);
  });

  it('rejects unknown model with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({ body: { model: 'gpt-4', max_tokens: 600 } }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 400);
    assert.match(body.error, /Unsupported model/);
  });

  it('accepts each model in the allowlist', async () => {
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-7']) {
      installFetchMock(defaultRoutes());
      const res = await triage.handler(makeEvent({ body: { model, max_tokens: 600 } }));
      uninstallFetchMock();
      assert.equal(res.statusCode, 200, 'model ' + model + ' should be accepted');
    }
  });

  it('defaults max_tokens to 1024 when missing', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6' } }));
    const anthropicCall = captured.find(c => c.url.includes('api.anthropic.com'));
    const sent = JSON.parse(anthropicCall.opts.body);
    assert.equal(sent.max_tokens, 1024);
    uninstallFetchMock();
  });

  it('defaults max_tokens to 1024 when zero or negative', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 0 } }));
    const c0 = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();

    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: -10 } }));
    const cNeg = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();

    assert.equal(c0.max_tokens, 1024);
    assert.equal(cNeg.max_tokens, 1024);
  });

  it('clamps max_tokens at the 4096 cap', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 1_000_000 } }));
    const anthropicCall = captured.find(c => c.url.includes('api.anthropic.com'));
    const sent = JSON.parse(anthropicCall.opts.body);
    assert.equal(sent.max_tokens, 4096);
    uninstallFetchMock();
  });

  it('passes through a valid max_tokens (e.g. 600) unchanged', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    assert.equal(sent.max_tokens, 600);
    uninstallFetchMock();
  });
});

describe('triage proxy — upstream behavior', () => {
  it('passes through Anthropic non-2xx verbatim', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 529, body: { type: 'error', error: { type: 'overloaded' } } },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 529);
    // Body should be passed through verbatim — we don't strip or
    // re-wrap upstream errors so the client sees the real cause.
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'overloaded');
  });

  it('returns 502 when Anthropic 200s with malformed JSON', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: 'this is not JSON, anthropic broke' },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const { status, body } = decode(res);
    assert.equal(status, 502);
    assert.match(body.error, /malformed JSON/i);
  });
});

describe('triage proxy — _relai telemetry envelope', () => {
  // The client persists this envelope onto the query_history row. If
  // its shape regresses, prompt_version / kb_version / cost_usd
  // columns silently start storing nulls and the observability
  // dashboards lose fidelity. Test the shape, not the values.

  it('attaches _relai with model, latency_ms, cost_usd, usage', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: { model: 'claude-sonnet-4-6', max_tokens: 600 },
    }));
    uninstallFetchMock();

    const parsed = JSON.parse(res.body);
    assert.ok(parsed._relai, '_relai envelope missing');
    assert.equal(parsed._relai.model, 'claude-sonnet-4-6');
    assert.equal(typeof parsed._relai.latency_ms, 'number');
    assert.ok(parsed._relai.latency_ms >= 0);
    // cost_usd is computed via computeTriageCost from the canned usage.
    // 100 fresh*3 + 50 out*15 + 2000 cache_read*0.30, all /1e6:
    //   = 0.0003 + 0.00075 + 0.0006 = 0.00165
    assert.equal(parsed._relai.cost_usd, 0.00165);
    assert.ok(parsed._relai.usage, 'usage echo missing');
    assert.equal(parsed._relai.usage.input_tokens, 100);
    assert.equal(parsed._relai.usage.cache_read_input_tokens, 2000);
  });

  it('cost_usd is null when usage is absent (malformed upstream response shape)', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: {
        status: 200,
        body: { content: [{ type: 'text', text: '{}' }] }, // no `usage` block
      },
    }));
    const res = await triage.handler(makeEvent({
      body: { model: 'claude-sonnet-4-6', max_tokens: 600 },
    }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    // Null cost is the documented "unpriced" signal — saveHistoryRecord
    // omits the column rather than writing 0, so the dashboards don't
    // skew toward "free" triages.
    assert.equal(parsed._relai.cost_usd, null);
  });
});

describe('triage proxy — forwards Anthropic auth + cache headers', () => {
  it('sends x-api-key and anthropic-version to upstream', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    const anthropicCall = captured.find(c => c.url.includes('api.anthropic.com'));
    uninstallFetchMock();
    assert.ok(anthropicCall, 'no fetch to anthropic captured');
    assert.equal(anthropicCall.opts.headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(anthropicCall.opts.headers['anthropic-version'], '2023-06-01');
    assert.equal(anthropicCall.opts.headers['Content-Type'], 'application/json');
  });

  it('preserves system + messages from the request body', async () => {
    installFetchMock(defaultRoutes());
    const sysBlocks = [
      { type: 'text', text: 'Base prompt here', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'KB here', cache_control: { type: 'ephemeral' } },
    ];
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: sysBlocks,
        messages: [{ role: 'user', content: 'I have nausea' }],
      },
    }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.deepEqual(sent.system, sysBlocks);
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'I have nausea' }]);
  });
});
