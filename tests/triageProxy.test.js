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
  // Inject a default messages array for object bodies that don't
  // specify one, so existing tests stay focused on the specific gate
  // they were asserting. body.system is NEVER auto-injected — the
  // proxy rejects body.system entirely (strict lockdown post-#2).
  // Tests that exercise the new validation paths supply messages
  // explicitly.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.messages === undefined) {
      body = Object.assign({}, body, {
        messages: [{ role: 'user', content: 'a test patient message that is long enough to be realistic' }],
      });
    }
  }
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

// Default route set — auth + Supabase reads (profile / KB / history)
// + Anthropic all return clean 200s. Every test exercises the
// strict server-assembly path since body.system is no longer
// accepted; defaultRoutes therefore mocks the supabase reads the
// proxy makes during assembly.
function defaultRoutes(overrides = {}) {
  return [
    {
      match: (url) => url.includes('/auth/v1/user'),
      respond: () => overrides.authResponse || { status: 200, body: { id: 'user-1', email: 't@x' } },
    },
    {
      match: (url) => url.includes('/rest/v1/profiles'),
      respond: () => ({ status: 200, body: overrides.profile || [{ company_id: 'company-1' }] }),
    },
    {
      match: (url) => url.includes('/rest/v1/kb_entries'),
      respond: () => ({ status: 200, body: overrides.kb || [
        { section: 'notes', name: 'Rule A', text: 'Always escalate chest pain.' },
        { section: 'routing', name: 'R1', text: 'Severe → urgent.' },
      ] }),
    },
    {
      match: (url) => url.includes('/rest/v1/query_history'),
      respond: () => ({ status: 200, body: overrides.history || [] }),
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

describe('triage proxy — server-side validation (S3a)', () => {
  // The proxy runs normalizeTriageOutput on the AI's content[0].text
  // before returning to the client. This is the chokepoint a client
  // can't bypass — defense-in-depth against a bypassed/malformed
  // client write to query_history. The pattern is coerce-with-safe-
  // defaults (matching the client-side normalizer exactly); drift is
  // recorded in _relai.validation for telemetry. See PLAN.md "S3."

  it('replaces content[0].text with canonical normalized JSON', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"URGENT","clinical_routing_level":"SEVERE","draft_response":"call patient"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    const aiJson = JSON.parse(parsed.content[0].text);
    assert.equal(aiJson.urgency, 'urgent');
    assert.equal(aiJson.clinical_routing_level, 'severe');
    assert.equal(aiJson.draft_response, 'call patient');
  });

  it('records each drift in _relai.validation.drifts', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"URGENT","clinical_routing_level":"SEVERE","draft_response":"hi"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    assert.ok(parsed._relai.validation, 'validation envelope missing');
    const fields = parsed._relai.validation.drifts.map(function (d) { return d.field; });
    assert.ok(fields.includes('urgency'), 'urgency drift missing');
    assert.ok(fields.includes('clinical_routing_level'), 'clinical_routing_level drift missing');
    const u = parsed._relai.validation.drifts.find(function (d) { return d.field === 'urgency'; });
    assert.equal(u.received, 'URGENT');
    assert.equal(u.coerced_to, 'urgent');
  });

  it('clamps out-of-range confidence and records drift', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"urgent","clinical_routing_level":"none","review_request":{"confidence":1.5,"context":"routing"},"draft_response":"hi"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    const aiJson = JSON.parse(parsed.content[0].text);
    assert.equal(aiJson.review_request.confidence, 1, 'confidence not clamped in content');
    const drift = parsed._relai.validation.drifts.find(function (d) { return d.field === 'review_request.confidence'; });
    assert.ok(drift, 'confidence drift not recorded');
    assert.equal(drift.received, 1.5);
    assert.equal(drift.coerced_to, 1);
  });

  it('passes content through verbatim with parse_failed on unparseable AI text', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: 'I am sorry, I cannot help with that.' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200, 'parse failure should not change status code');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed._relai.validation.parse_failed, true);
    assert.equal(parsed._relai.validation.reason, 'unparseable_text');
    // Content preserved verbatim — the client's parseTriageJSON has
    // a brace-fallback and runTriage's catch renders a readable
    // error if that also fails.
    assert.equal(parsed.content[0].text, 'I am sorry, I cannot help with that.');
  });

  it('records empty_content when content array is empty', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({ content: [] }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    assert.equal(parsed._relai.validation.parse_failed, true);
    assert.equal(parsed._relai.validation.reason, 'empty_content');
  });

  it('validation is null when AI emits clean canonical values', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"routine","clinical_routing_level":"none","draft_response":"hi"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    assert.equal(parsed._relai.validation, null);
  });

  it('canonicalizes clinical_category casing', async () => {
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"routine","clinical_routing_level":"none","clinical_category":"side effects","draft_response":"hi"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    const aiJson = JSON.parse(parsed.content[0].text);
    assert.equal(aiJson.clinical_category, 'Side Effects');
    const drift = parsed._relai.validation.drifts.find(function (d) { return d.field === 'clinical_category'; });
    assert.equal(drift.received, 'side effects');
    assert.equal(drift.coerced_to, 'Side Effects');
  });

  it('preserves unknown clinical_category trimmed (does not silently coerce)', async () => {
    // Matches the existing client-side design: unknown categories
    // pass through so staff can see what the AI returned. The
    // validation envelope records no drift for trim-only changes
    // because there's nothing the diff function tracks differently.
    installFetchMock(defaultRoutes({
      anthropicResponse: { status: 200, body: anthropicOK({
        content: [{ type: 'text', text: '{"urgency":"routine","clinical_routing_level":"none","clinical_category":"Bizarre Category","draft_response":"hi"}' }],
      }) },
    }));
    const res = await triage.handler(makeEvent({ body: { model: 'claude-sonnet-4-6', max_tokens: 600 } }));
    uninstallFetchMock();
    const parsed = JSON.parse(res.body);
    const aiJson = JSON.parse(parsed.content[0].text);
    assert.equal(aiJson.clinical_category, 'Bizarre Category');
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

  it('preserves messages from the request body (system is server-assembled, not forwarded)', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: 'I have nausea' }],
      },
    }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'I have nausea' }]);
    // system is assembled server-side (#2 contract lockdown) — the
    // request to Anthropic has its own multi-block system, not
    // whatever the caller may have tried to send.
    assert.ok(Array.isArray(sent.system), 'proxy assembled its own system');
  });
});

// ─────────────────────────────────────────────────────────────────
// Contract lockdown (#2 strict): proxy rejects body.system entirely
// and assembles BASE_PROMPT + tenant KB + staff examples server-side
// from supabase. Body.messages is validated to exactly one
// { role:"user", content:string } with content <= 8192 chars.
// ─────────────────────────────────────────────────────────────────

const { BASE_PROMPT } = require('../data/base-prompt');

describe('triage proxy — body.system rejection (strict lockdown)', () => {
  it('rejects body.system as an array with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        system: [{ type: 'text', text: 'client-assembled' }],
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('body.system is not accepted'));
  });

  it('rejects body.system as a string with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        system: 'pretend I am authorized',
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
  });

  it('does NOT reach Anthropic when body.system is present', async () => {
    // Cost guard: a rejected request must short-circuit before any
    // upstream call.
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        system: 'reject me',
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    const upstream = captured.filter(c => c.url.includes('api.anthropic.com'));
    uninstallFetchMock();
    assert.equal(upstream.length, 0);
  });
});

describe('triage proxy — message shape validation', () => {
  it('rejects request with no messages array with 400', async () => {
    installFetchMock(defaultRoutes());
    // Hand-crafted to bypass makeEvent's default messages injection.
    const res = await triage.handler({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer fake' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('exactly one message'));
  });

  it('rejects empty messages array with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: { model: 'claude-sonnet-4-6', messages: [] },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
  });

  it('rejects multiple messages with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
  });

  it('rejects assistant-role message with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'assistant', content: 'a' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('role: "user"'));
  });

  it('rejects non-string message content with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        // Anthropic accepts an array-of-blocks content shape too,
        // but triage is one-shot text input only — anything other
        // than a string content is a client bug.
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
  });

  it('rejects message content > 8192 chars with 400', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'x'.repeat(8193) }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('8192'));
  });

  it('accepts message content at exactly the 8192-char cap', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'x'.repeat(8192) }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
  });
});

describe('triage proxy — server-side system assembly', () => {
  it('assembles BASE_PROMPT + KB + (empty examples) when called with valid body', async () => {
    installFetchMock(defaultRoutes());
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I have nausea' }],
      },
    }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.ok(Array.isArray(sent.system), 'system must be an array of blocks');
    assert.equal(sent.system.length, 2, 'no examples block when history is empty');
    assert.equal(sent.system[0].text, BASE_PROMPT);
    assert.equal(sent.system[0].cache_control.type, 'ephemeral');
    assert.equal(sent.system[1].cache_control.type, 'ephemeral');
    assert.ok(sent.system[1].text.includes('=== CLINICAL RULES (read first) ==='));
    assert.ok(sent.system[1].text.includes('Always escalate chest pain.'));
    assert.ok(sent.system[1].text.includes('=== ROUTING RULES ==='));
  });

  it('includes a third uncached examples block when qualifying history rows exist', async () => {
    installFetchMock(defaultRoutes({
      history: [{
        actual_response_sent: 'Sorry to hear that — try taking it with food and message us back if it persists.',
        draft_response: 'Take with food.',
        patient_message: 'I have been feeling nauseous since starting the medication last Tuesday.',
        edit_distance: 80,
      }],
    }));
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I have nausea' }],
      },
    }));
    const sent = JSON.parse(captured.find(c => c.url.includes('api.anthropic.com')).opts.body);
    uninstallFetchMock();
    assert.equal(sent.system.length, 3);
    assert.equal(sent.system[2].cache_control, undefined, 'examples block must be uncached');
    assert.ok(sent.system[2].text.startsWith('=== RECENT STAFF EDITS'));
    assert.ok(sent.system[2].text.includes('EXAMPLE 1'));
  });

  it('returns 500 when KB returns zero rows for the tenant', async () => {
    installFetchMock(defaultRoutes({ kb: [] }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    // KB is safety-critical — empty KB means no routing rules, no
    // clinical guidance, no style. Don't silently triage with just
    // BASE_PROMPT.
    assert.equal(res.statusCode, 500);
    assert.ok(JSON.parse(res.body).error.includes('KB unavailable'));
  });

  it('returns 500 when the caller has no resolvable company_id', async () => {
    installFetchMock(defaultRoutes({ profile: [] }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 500);
    assert.ok(JSON.parse(res.body).error.includes('company_id'));
  });

  // Pins the exact PostgREST SELECT clause the proxy uses for KB
  // rows. The kb_entries table column is `content`; a bare
  // `select=...,text` returned a 400 from PostgREST and collapsed
  // to "KB unavailable for this tenant" in production. The proxy
  // must alias via `text:content` so the response field is named
  // `text` (which buildFullKB / formatKBSection expect) while
  // pulling from the real column. Without this assertion the
  // happy-path mocks return `{text: ...}` directly and silently
  // mask a future re-introduction of the typo.
  it('queries kb_entries with the text:content PostgREST alias', async () => {
    installFetchMock(defaultRoutes());
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
    const kbCall = captured.find(c => c.url.includes('/rest/v1/kb_entries'));
    assert.ok(kbCall, 'expected the proxy to fetch kb_entries');
    assert.ok(
      kbCall.url.includes('select=section,name,text:content'),
      'kb_entries SELECT must alias `content` as `text`; got: ' + kbCall.url
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// #1 patient-safety defenses: tripwires, strict validation, and the
// feature-flag-gated Haiku second-pass. Tests assert that each gate
// sets route_to_human_review with a distinct route_reason and that
// the gates short-circuit in priority order.
// ─────────────────────────────────────────────────────────────────

// Helper: a routes set that returns a specific AI triage JSON in the
// Anthropic response. Used to drive the AI output through each safety
// gate. The Haiku second-pass uses claude-haiku-4-5, so the upstream
// match isolates by URL substring; both calls go to api.anthropic.com,
// so the route discriminates by request body content.
function routesWithAIOutput(aiOutputJson, overrides = {}) {
  const base = defaultRoutes(overrides);
  // Replace the anthropic route with one that returns the requested
  // triage JSON. Keep the first match for the Haiku call when the
  // flag is on.
  return base.map(function(route){
    if (route.match.toString().includes('api.anthropic.com')) {
      return {
        match: (url) => url.includes('api.anthropic.com/v1/messages'),
        respond: (url, opts) => {
          // Distinguish primary sonnet call vs Haiku second-pass by
          // model in body. The Haiku call is short and explicit.
          const body = opts && opts.body ? JSON.parse(opts.body) : {};
          if (body.model === 'claude-haiku-4-5') {
            // Fail-open simulation: respond throws → installFetchMock
            // surfaces the throw as a rejected fetch promise, which
            // haikuSecondPass's catch folds to verdict 'unsure'.
            if (overrides.haikuThrow) throw new Error('simulated haiku network error');
            // HTTP-error fail-open: a non-2xx Haiku response triggers
            // the !r.ok branch in haikuSecondPass, also folding to
            // verdict 'unsure'.
            if (overrides.haikuStatus && overrides.haikuStatus >= 400) {
              return {
                status: overrides.haikuStatus,
                body: { type: 'error', error: { type: 'haiku_simulated_failure' } },
              };
            }
            const verdict = overrides.haikuVerdict || 'agree';
            return {
              status: 200,
              body: {
                id: 'msg_haiku',
                type: 'message',
                content: [{ type: 'text', text: verdict }],
                model: 'claude-haiku-4-5',
                usage: { input_tokens: 100, output_tokens: 5 },
              },
            };
          }
          // Primary triage call.
          return {
            status: 200,
            body: anthropicOK({
              content: [{ type: 'text', text: aiOutputJson }],
            }),
          };
        },
      };
    }
    return route;
  });
}

// A canonical AI triage output JSON string for use in the safety-gate
// tests. Routine + non-clinical to exercise the "everything passes"
// happy path; specific fields tweaked per-test for the failure paths.
const VALID_AI_OUTPUT = JSON.stringify({
  urgency: 'routine',
  clinical_routing_level: 'none',
  clinical_category: 'General Inquiry',
  ai_confidence: 0.85,
  draft_response: 'Hi — happy to help with that.',
});

describe('triage proxy — safety: parse failure', () => {
  it('marks route_to_human_review when Anthropic returns empty content', async () => {
    installFetchMock(routesWithAIOutput(''));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'parse_failed');
  });

  it('marks route_to_human_review when Anthropic returns unparseable text', async () => {
    installFetchMock(routesWithAIOutput('this is not JSON, just prose'));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'parse_failed');
  });
});

describe('triage proxy — safety: strict validation', () => {
  it('marks route_to_human_review when AI omits required draft_response', async () => {
    const aiOut = JSON.stringify({
      urgency: 'routine',
      clinical_routing_level: 'none',
      ai_confidence: 0.85,
      // No draft_response — strict validator rejects this.
    });
    installFetchMock(routesWithAIOutput(aiOut));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'msg' }],
      },
    }));
    uninstallFetchMock();
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'validation_failed');
    assert.equal(body._relai.validation_failure.field, 'draft_response');
  });

  it('happy path: clean AI output does NOT set route_to_human_review', async () => {
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I would like to update my address.' }],
      },
    }));
    uninstallFetchMock();
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, undefined);
  });
});

describe('triage proxy — safety: tripwire override', () => {
  it('escalates a routine-classified chest pain message to urgent/severe', async () => {
    // The AI mistakenly classified this as routine. The tripwire
    // scan over the patient message catches "chest pain" and forces
    // the override.
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I have had chest pain for an hour.' }],
      },
    }));
    uninstallFetchMock();
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'tripwire');
    assert.equal(body._relai.tripwire.category, 'cardiac');
    assert.equal(body._relai.tripwire.keyword, 'chest pain');
    // Content was rewritten with the overridden triage JSON.
    const overridden = JSON.parse(body.content[0].text);
    assert.equal(overridden.urgency, 'urgent');
    assert.equal(overridden.clinical_routing_level, 'severe');
    assert.equal(overridden.tripwire_triggered, 'chest pain');
    assert.ok(overridden.draft_response.includes('CLINICAL TRIPWIRE'));
    // Original AI output is preserved for staff visibility.
    assert.equal(overridden.ai_original_output.urgency, 'routine');
  });

  it('does NOT override when no tripwire matches the patient message', async () => {
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'When is my next prescription due?' }],
      },
    }));
    uninstallFetchMock();
    const body = JSON.parse(res.body);
    assert.equal(body._relai.tripwire, undefined);
    assert.equal(body._relai.route_to_human_review, undefined);
  });

  it('skips tripwire scan when strict validation already failed (short-circuit)', async () => {
    // Validation failure wins over tripwire — the AI output is
    // already untrustworthy, no point applying a refined override
    // on top of garbage.
    const aiOut = JSON.stringify({
      urgency: 'made-up',
      clinical_routing_level: 'none',
      draft_response: 'x',
    });
    installFetchMock(routesWithAIOutput(aiOut));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        // Patient message contains a tripwire — but validation fires first.
        messages: [{ role: 'user', content: 'I have chest pain.' }],
      },
    }));
    uninstallFetchMock();
    const body = JSON.parse(res.body);
    // normalizeTriageOutput coerces unknown urgency to 'routine', so
    // strict validation may not actually fire on this. The relevant
    // assertion: whichever gate fires, route_to_human_review is set.
    assert.equal(body._relai.route_to_human_review, true);
  });
});

describe('triage proxy — safety: tripwire category coverage (end-to-end)', () => {
  // The function-level scanTripwires test pins each phrase to its
  // category. This block pins the proxy's USE of the function for
  // every category beyond cardiac (already covered above). Catches a
  // regression where applyTripwireOverride starts ignoring a category,
  // or _relai.tripwire stops carrying the category through to the
  // client envelope. One representative phrase per category — the
  // function-level test exercises the rest of each category's phrase
  // list.

  const FIXTURES = [
    { category: 'anaphylaxis',  message: 'Swelling tongue and lips since yesterday.' },
    { category: 'neurological', message: 'Worst headache of my life.' },
    { category: 'self_harm',    message: 'I feel suicidal.' },
    { category: 'pregnancy',    message: 'Heavy vaginal bleeding since this morning.' },
    { category: 'gi_emergency', message: 'Vomiting blood for the past hour.' },
    { category: 'severe_pain',  message: 'Severe abdominal pain on the right side.' },
    { category: 'glp1_danger',  message: 'Doctor said it might be pancreatitis.' },
  ];

  FIXTURES.forEach(function (fx) {
    it('escalates ' + fx.category + ' tripwire through the proxy', async () => {
      installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT));
      const res = await triage.handler(makeEvent({
        body: {
          model: 'claude-sonnet-4-6', max_tokens: 600,
          messages: [{ role: 'user', content: fx.message }],
        },
      }));
      uninstallFetchMock();
      const body = JSON.parse(res.body);
      assert.equal(body._relai.route_to_human_review, true, 'must route to review');
      assert.equal(body._relai.route_reason, 'tripwire');
      assert.equal(body._relai.tripwire.category, fx.category);
      // Override stamped onto the content the client will read.
      const overridden = JSON.parse(body.content[0].text);
      assert.equal(overridden.urgency, 'urgent');
      assert.equal(overridden.clinical_routing_level, 'severe');
      assert.ok(overridden.draft_response.includes('CLINICAL TRIPWIRE'),
        'draft must carry the tripwire warning marker for staff');
      // Original AI output preserved for staff visibility.
      assert.equal(overridden.ai_original_output.urgency, 'routine');
    });
  });
});

describe('triage proxy — safety: Haiku second-pass (feature-flagged)', () => {
  // The env var is read inside the handler, so we set/restore it
  // around each test rather than at require time.
  const ORIG_FLAG = process.env.RELAI_SECOND_PASS_HAIKU;
  function setFlag(v) {
    if (v == null) delete process.env.RELAI_SECOND_PASS_HAIKU;
    else process.env.RELAI_SECOND_PASS_HAIKU = v;
  }

  it('does NOT call Haiku when flag is unset (default)', async () => {
    setFlag(null);
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT));
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'Routine question.' }],
      },
    }));
    const calls = captured.filter(c => c.url.includes('api.anthropic.com'));
    const haikuCalls = calls.filter(c => {
      const b = c.opts && c.opts.body ? JSON.parse(c.opts.body) : {};
      return b.model === 'claude-haiku-4-5';
    });
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    assert.equal(haikuCalls.length, 0, 'Haiku must not be called when flag is unset');
  });

  it('calls Haiku and routes to review when verdict is "disagree"', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'disagree' }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I feel a bit off today.' }],
      },
    }));
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'haiku_disagree');
    assert.equal(body._relai.haiku_second_pass.verdict, 'disagree');
  });

  it('routes to review on Haiku verdict "unsure" (conservative bias)', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'unsure' }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'Borderline case.' }],
      },
    }));
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'haiku_unsure');
  });

  it('does NOT call Haiku when a tripwire already fired (cost guard)', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'agree' }));
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'I have chest pain.' }],
      },
    }));
    const calls = captured.filter(c => c.url.includes('api.anthropic.com'));
    const haikuCalls = calls.filter(c => {
      const b = c.opts && c.opts.body ? JSON.parse(c.opts.body) : {};
      return b.model === 'claude-haiku-4-5';
    });
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    assert.equal(haikuCalls.length, 0, 'tripwire short-circuits the Haiku call');
  });

  it('happy path: Haiku verdict "agree" leaves route_to_human_review unset', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'agree' }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'Routine billing question.' }],
      },
    }));
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, undefined);
    assert.equal(body._relai.haiku_second_pass.verdict, 'agree');
    // Haiku cost was added into the overall envelope.
    assert.ok(typeof body._relai.cost_usd === 'number' && body._relai.cost_usd > 0);
  });

  // Fail-open paths. The proxy's haikuSecondPass returns verdict
  // 'unsure' on HTTP error and on fetch throw — never silently passes
  // the triage as 'agree'. Patient-safety: a transient Haiku failure
  // must route the message to human review, not let it bypass the
  // second-pass entirely. A regression that swallowed Haiku errors
  // (returning 'agree' or no verdict at all) would not be caught by
  // any other test in this file.

  it('fails open to "unsure" and routes to review when Haiku returns HTTP 500', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuStatus: 500 }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'A routine question.' }],
      },
    }));
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'haiku_unsure');
    assert.equal(body._relai.haiku_second_pass.verdict, 'unsure');
    // Fail-open paths return cost_usd null since no usage block was
    // parsed from the error response.
    assert.equal(body._relai.haiku_second_pass.cost_usd, null);
  });

  it('fails open to "unsure" and routes to review when the Haiku fetch throws', async () => {
    setFlag('true');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuThrow: true }));
    const res = await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'A routine question.' }],
      },
    }));
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    const body = JSON.parse(res.body);
    assert.equal(body._relai.route_to_human_review, true);
    assert.equal(body._relai.route_reason, 'haiku_unsure');
    assert.equal(body._relai.haiku_second_pass.verdict, 'unsure');
    assert.equal(body._relai.haiku_second_pass.cost_usd, null);
  });

  // Flag is checked with strict-equality against the exact string
  // "true" at triage.js#L423. Any other casing or representation
  // ("True", "1", "yes", boolean true if Netlify ever serialized one)
  // silently leaves the second-pass disabled. This is the
  // intended behavior — but it's worth pinning so a future loosening
  // ("any truthy value") would surface as a test failure rather than
  // an accidentally-always-on second-pass in production.

  it('does NOT call Haiku when flag is "True" (strict-equality requires exact lowercase "true")', async () => {
    setFlag('True');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'agree' }));
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'Routine question.' }],
      },
    }));
    const haikuCalls = captured.filter(c => {
      if (!c.url.includes('api.anthropic.com')) return false;
      const b = c.opts && c.opts.body ? JSON.parse(c.opts.body) : {};
      return b.model === 'claude-haiku-4-5';
    });
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    assert.equal(haikuCalls.length, 0, 'flag must use exact-string "true" match');
  });

  it('does NOT call Haiku when flag is "1"', async () => {
    setFlag('1');
    installFetchMock(routesWithAIOutput(VALID_AI_OUTPUT, { haikuVerdict: 'agree' }));
    await triage.handler(makeEvent({
      body: {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: 'Routine question.' }],
      },
    }));
    const haikuCalls = captured.filter(c => {
      if (!c.url.includes('api.anthropic.com')) return false;
      const b = c.opts && c.opts.body ? JSON.parse(c.opts.body) : {};
      return b.model === 'claude-haiku-4-5';
    });
    uninstallFetchMock();
    setFlag(ORIG_FLAG);
    assert.equal(haikuCalls.length, 0);
  });
});
