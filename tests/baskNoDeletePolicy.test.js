// tests/baskNoDeletePolicy.test.js
//
// Tests the runtime enforcement of the no-DELETE policy in
// netlify/functions/bask.js. The policy is documented at the top of
// that file (Care Station never initiates destructive operations on
// Bask clinical records); safeBaskFetch is the runtime guard.
//
// Belt-and-suspenders: the policy comment is the letter of the rule;
// safeBaskFetch enforces the literal-DELETE case in code so a future
// PR that wires a real Bask call can't accidentally smuggle a DELETE
// through.

const {
  safeBaskFetch,
  BASK_FORBIDDEN_METHODS,
} = require('../netlify/functions/bask.js');

// Patch global.fetch for these tests so the wrapper has something to
// call through to when the method is permitted. We're asserting the
// wrapper's gate, not the network behavior.
const realFetch = global.fetch;
let lastFetchCall = null;
function installFetchStub() {
  lastFetchCall = null;
  global.fetch = async function (url, opts) {
    lastFetchCall = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}
function uninstallFetchStub() {
  global.fetch = realFetch;
  lastFetchCall = null;
}

describe('safeBaskFetch — refuses destructive methods', () => {
  it('throws on DELETE', async () => {
    installFetchStub();
    try {
      let threw = false;
      try {
        await safeBaskFetch('https://api.example/test', { method: 'DELETE' });
      } catch (e) {
        threw = true;
        assert.match(e.message, /no-DELETE policy/);
        assert.match(e.message, /DELETE/);
      }
      assert.equal(threw, true, 'safeBaskFetch should have thrown on DELETE');
      assert.equal(lastFetchCall, null, 'fetch must not be invoked for DELETE');
    } finally {
      uninstallFetchStub();
    }
  });

  it('throws on lowercase delete (method is case-normalized)', async () => {
    installFetchStub();
    try {
      let threw = false;
      try {
        await safeBaskFetch('https://api.example/test', { method: 'delete' });
      } catch (e) {
        threw = true;
      }
      assert.equal(threw, true);
      assert.equal(lastFetchCall, null);
    } finally {
      uninstallFetchStub();
    }
  });
});

describe('safeBaskFetch — permits non-destructive methods', () => {
  it('allows POST (the primary outbound verb)', async () => {
    installFetchStub();
    try {
      const r = await safeBaskFetch('https://api.example/messages', {
        method: 'POST',
        body: 'x',
      });
      assert.equal(r.ok, true);
      assert.equal(lastFetchCall.url, 'https://api.example/messages');
      assert.equal(lastFetchCall.opts.method, 'POST');
    } finally {
      uninstallFetchStub();
    }
  });

  it('allows GET (lookups)', async () => {
    installFetchStub();
    try {
      const r = await safeBaskFetch('https://api.example/patients/1', {
        method: 'GET',
      });
      assert.equal(r.ok, true);
    } finally {
      uninstallFetchStub();
    }
  });

  it('allows PATCH and PUT (legitimate additive writes; destructive payloads are blocked by code review + policy comment, not method gate)', async () => {
    installFetchStub();
    try {
      const r1 = await safeBaskFetch('https://api.example/x', { method: 'PATCH', body: '{}' });
      assert.equal(r1.ok, true);
      const r2 = await safeBaskFetch('https://api.example/x', { method: 'PUT', body: '{}' });
      assert.equal(r2.ok, true);
    } finally {
      uninstallFetchStub();
    }
  });

  it('defaults to GET when method is omitted', async () => {
    installFetchStub();
    try {
      const r = await safeBaskFetch('https://api.example/x');
      assert.equal(r.ok, true);
    } finally {
      uninstallFetchStub();
    }
  });

  it('defaults to GET when opts is omitted entirely', async () => {
    installFetchStub();
    try {
      const r = await safeBaskFetch('https://api.example/x');
      assert.equal(r.ok, true);
    } finally {
      uninstallFetchStub();
    }
  });
});

describe('BASK_FORBIDDEN_METHODS — explicit policy surface', () => {
  it('includes DELETE', () => {
    assert.equal(BASK_FORBIDDEN_METHODS.has('DELETE'), true);
  });

  it('does NOT include POST/GET/PATCH/PUT (additive verbs)', () => {
    assert.equal(BASK_FORBIDDEN_METHODS.has('POST'), false);
    assert.equal(BASK_FORBIDDEN_METHODS.has('GET'), false);
    assert.equal(BASK_FORBIDDEN_METHODS.has('PATCH'), false);
    assert.equal(BASK_FORBIDDEN_METHODS.has('PUT'), false);
  });
});
