// tests/healthieAdapter.test.js
//
// Unit tests for the pure helpers backing the Healthie inbound
// adapter (netlify/functions/healthie.js). Mirrors the test surface
// of intercom.test.js + baskNoDeletePolicy.test.js: signature
// verification, event-type gating, payload normalization, external_id
// formatting, no-DELETE policy enforcement, coalescing decision.
//
// What's NOT tested here:
//   * The full handler (fetch-mocked integration test) — same convention
//     as the intercom handler, where the orchestration is reviewed in
//     code and the decision points are the unit-test surface.
//   * fetchHealthieNote — depends on a live HEALTHIE_API_KEY and is
//     gated to no-op without it. Behavior is logged at runtime; tests
//     would just exercise the no-op path.

const crypto = require('crypto');

// Env vars must be set before requiring healthie.js because it reads
// some at module load (matches firstAdminBootstrap.test.js pattern).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.local';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon';

const {
  computeContentDigest,
  buildCanonicalString,
  parseSignatureHeader,
  verifyHealthieSignature,
  isSupportedEvent,
  isIgnoredEvent,
  buildExternalId,
  buildCoalescingFields,
  normalizeNoteForInsert,
  detectDestructiveGraphQLOp,
  safeHealthieFetch,
  HEALTHIE_SUPPORTED_EVENTS,
  HEALTHIE_IGNORED_EVENTS,
  HEALTHIE_FORBIDDEN_METHODS,
  HOLD_WINDOW_MS,
} = require('../netlify/functions/healthie.js');

// ─────────────────────────────────────────────────────────────────
// computeContentDigest
// ─────────────────────────────────────────────────────────────────

describe('computeContentDigest', () => {
  it('produces the structured-fields sha-256 digest of the body', () => {
    const body = '{"event_type":"message.created"}';
    const expected = 'sha-256=:' + crypto.createHash('sha256').update(body).digest('base64') + ':';
    assert.equal(computeContentDigest(body), expected);
  });

  it('handles empty body without throwing', () => {
    const out = computeContentDigest('');
    assert.match(out, /^sha-256=:.+:$/);
  });

  it('handles undefined body without throwing', () => {
    const out = computeContentDigest(undefined);
    assert.match(out, /^sha-256=:.+:$/);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildCanonicalString
// ─────────────────────────────────────────────────────────────────

describe('buildCanonicalString', () => {
  it('joins all six components space-separated in fixed order', () => {
    const out = buildCanonicalString({
      method: 'POST',
      path: '/.netlify/functions/healthie',
      query: '',
      contentDigest: 'sha-256=:abc:',
      contentType: 'application/json',
      contentLength: 42,
    });
    assert.equal(out, 'POST /.netlify/functions/healthie  sha-256=:abc: application/json 42');
  });

  it('uppercases the method', () => {
    const out = buildCanonicalString({ method: 'post', path: '/x', contentLength: 0 });
    assert.equal(out.split(' ')[0], 'POST');
  });

  it('treats missing fields as empty', () => {
    const out = buildCanonicalString({});
    assert.equal(out, '     ');
  });
});

// ─────────────────────────────────────────────────────────────────
// parseSignatureHeader
// ─────────────────────────────────────────────────────────────────

describe('parseSignatureHeader', () => {
  it('parses structured-fields format (sig1=:<base64>:)', () => {
    const raw = Buffer.from('hello-bytes');
    const header = 'sig1=:' + raw.toString('base64') + ':';
    const parsed = parseSignatureHeader(header);
    assert.equal(parsed.equals(raw), true);
  });

  it('parses bare base64', () => {
    const raw = Buffer.from('hello-bytes');
    const parsed = parseSignatureHeader(raw.toString('base64'));
    assert.equal(parsed.equals(raw), true);
  });

  it('parses bare hex', () => {
    const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const parsed = parseSignatureHeader('deadbeef');
    assert.equal(parsed.equals(raw), true);
  });

  it('returns null on empty / null / undefined', () => {
    assert.equal(parseSignatureHeader(''), null);
    assert.equal(parseSignatureHeader(null), null);
    assert.equal(parseSignatureHeader(undefined), null);
  });

  it('returns null on garbage that matches neither format', () => {
    assert.equal(parseSignatureHeader('not even a signature 🤷'), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// verifyHealthieSignature
// ─────────────────────────────────────────────────────────────────

describe('verifyHealthieSignature', () => {
  const secret = 'whsec_test-secret-for-hmac';
  const method = 'POST';
  const path = '/.netlify/functions/healthie';
  const query = '';
  const rawBody = '{"resource_id":"123","event_type":"message.created"}';
  const contentDigest = computeContentDigest(rawBody);
  const contentType = 'application/json';
  const contentLength = String(Buffer.byteLength(rawBody, 'utf8'));

  function signedHeaders() {
    const canonical = buildCanonicalString({
      method, path, query, contentDigest, contentType, contentLength,
    });
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest();
    return {
      'signature': 'sig1=:' + sig.toString('base64') + ':',
      'content-type': contentType,
      'content-length': contentLength,
    };
  }

  it('accepts a valid signature', () => {
    assert.equal(
      verifyHealthieSignature({ method, path, query, rawBody, headers: signedHeaders(), secret }),
      true
    );
  });

  it('rejects a tampered body', () => {
    assert.equal(
      verifyHealthieSignature({
        method, path, query, rawBody: rawBody + 'x', headers: signedHeaders(), secret,
      }),
      false
    );
  });

  it('rejects a tampered method', () => {
    assert.equal(
      verifyHealthieSignature({
        method: 'GET', path, query, rawBody, headers: signedHeaders(), secret,
      }),
      false
    );
  });

  it('rejects a tampered path', () => {
    assert.equal(
      verifyHealthieSignature({
        method, path: '/other', query, rawBody, headers: signedHeaders(), secret,
      }),
      false
    );
  });

  it('rejects a wrong secret', () => {
    assert.equal(
      verifyHealthieSignature({
        method, path, query, rawBody, headers: signedHeaders(), secret: secret + 'x',
      }),
      false
    );
  });

  it('rejects an empty / null / missing secret', () => {
    assert.equal(verifyHealthieSignature({ method, path, query, rawBody, headers: signedHeaders(), secret: '' }), false);
    assert.equal(verifyHealthieSignature({ method, path, query, rawBody, headers: signedHeaders(), secret: null }), false);
  });

  it('rejects when the Signature header is missing', () => {
    assert.equal(
      verifyHealthieSignature({
        method, path, query, rawBody, headers: { 'content-type': contentType }, secret,
      }),
      false
    );
  });

  it('rejects when the Signature header is garbage', () => {
    assert.equal(
      verifyHealthieSignature({
        method, path, query, rawBody, headers: { 'signature': 'not-a-sig' }, secret,
      }),
      false
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// isSupportedEvent / isIgnoredEvent
// ─────────────────────────────────────────────────────────────────

describe('event-type gating', () => {
  it('isSupportedEvent → true for message.created', () => {
    assert.equal(isSupportedEvent('message.created'), true);
  });

  it('isSupportedEvent → false for anything else', () => {
    assert.equal(isSupportedEvent('message.deleted'), false);
    assert.equal(isSupportedEvent('conversation.created'), false);
    assert.equal(isSupportedEvent('unknown.event'), false);
    assert.equal(isSupportedEvent(''), false);
    assert.equal(isSupportedEvent(undefined), false);
  });

  it('isIgnoredEvent → true for known no-op events', () => {
    assert.equal(isIgnoredEvent('message.deleted'), true);
    assert.equal(isIgnoredEvent('conversation_membership.viewed'), true);
    assert.equal(isIgnoredEvent('conversation.updated'), true);
  });

  it('isIgnoredEvent → false for supported + unknown', () => {
    assert.equal(isIgnoredEvent('message.created'), false);
    assert.equal(isIgnoredEvent('completely.unknown'), false);
  });

  it('supported and ignored sets do not overlap', () => {
    for (const e of HEALTHIE_SUPPORTED_EVENTS) {
      assert.equal(HEALTHIE_IGNORED_EVENTS.has(e), false, 'event in both sets: ' + e);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// buildExternalId
// ─────────────────────────────────────────────────────────────────

describe('buildExternalId', () => {
  it('formats "healthie:<type>:<id>"', () => {
    assert.equal(buildExternalId('Note', '12345'), 'healthie:Note:12345');
  });

  it('returns null when type is missing', () => {
    assert.equal(buildExternalId('', '12345'), null);
    assert.equal(buildExternalId(null, '12345'), null);
  });

  it('returns null when id is missing', () => {
    assert.equal(buildExternalId('Note', ''), null);
    assert.equal(buildExternalId('Note', null), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// normalizeNoteForInsert
// ─────────────────────────────────────────────────────────────────

describe('normalizeNoteForInsert', () => {
  it('extracts patient-authored note content + identity', () => {
    const note = {
      id: '999',
      content: 'I have a question about my dose',
      creator: {
        id: '2179',
        full_name: 'Patient One',
        email: 'p1@example.com',
        dietitian: false,
      },
      conversation: { id: 'conv-42' },
    };
    const out = normalizeNoteForInsert(note);
    assert.equal(out.noteId, '999');
    assert.equal(out.conversationId, 'conv-42');
    assert.equal(out.content, 'I have a question about my dose');
    assert.equal(out.patientId, '2179');
    assert.equal(out.patientName, 'Patient One');
    assert.equal(out.patientEmail, 'p1@example.com');
  });

  it('returns null when the creator is a dietitian (provider-authored)', () => {
    const note = {
      id: '999',
      content: 'Please follow up next week',
      creator: { id: 'prov-1', full_name: 'Dr. Smith', dietitian: true },
      conversation: { id: 'conv-42' },
    };
    assert.equal(normalizeNoteForInsert(note), null);
  });

  it('returns null when content is empty / whitespace', () => {
    const note = {
      id: '999',
      content: '   ',
      creator: { id: '1', dietitian: false },
      conversation: { id: 'c' },
    };
    assert.equal(normalizeNoteForInsert(note), null);
  });

  it('returns null when note is null / missing id', () => {
    assert.equal(normalizeNoteForInsert(null), null);
    assert.equal(normalizeNoteForInsert({}), null);
  });

  it('allows missing conversation (rare but possible — null conversation_id)', () => {
    const note = {
      id: '999',
      content: 'hi',
      creator: { id: '1', dietitian: false },
    };
    const out = normalizeNoteForInsert(note);
    assert.equal(out.conversationId, null);
    assert.equal(out.content, 'hi');
  });

  it('trims content whitespace', () => {
    const note = {
      id: '999',
      content: '   hello   ',
      creator: { id: '1', dietitian: false },
      conversation: { id: 'c' },
    };
    const out = normalizeNoteForInsert(note);
    assert.equal(out.content, 'hello');
  });
});

// ─────────────────────────────────────────────────────────────────
// detectDestructiveGraphQLOp
// ─────────────────────────────────────────────────────────────────

describe('detectDestructiveGraphQLOp', () => {
  it('flags mutation deleteNote', () => {
    const q = 'mutation deleteNote($id: ID!) { deleteNote(id: $id) { id } }';
    assert.equal(detectDestructiveGraphQLOp(q), 'deleteNote');
  });

  it('flags mutation DeleteConversation (case-insensitive match)', () => {
    const q = 'mutation DeleteConversation { deleteConversation(id: 1) { id } }';
    assert.equal(detectDestructiveGraphQLOp(q), 'DeleteConversation');
  });

  it('flags shorthand mutation { deleteFoo(...) }', () => {
    const q = 'mutation { deleteFoo(id: 1) { id } }';
    assert.equal(detectDestructiveGraphQLOp(q), 'deleteFoo');
  });

  it('does not flag a mutation whose name does not start with delete', () => {
    const q = 'mutation CreateNote($input: NoteInput!) { createNote(input: $input) { id } }';
    assert.equal(detectDestructiveGraphQLOp(q), null);
  });

  it('does not flag queries', () => {
    const q = 'query GetNote($id: ID!) { note(id: $id) { id content } }';
    assert.equal(detectDestructiveGraphQLOp(q), null);
  });

  it('returns null on non-string input', () => {
    assert.equal(detectDestructiveGraphQLOp(null), null);
    assert.equal(detectDestructiveGraphQLOp(undefined), null);
    assert.equal(detectDestructiveGraphQLOp(123), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// safeHealthieFetch
// ─────────────────────────────────────────────────────────────────

describe('safeHealthieFetch', () => {
  const realFetch = global.fetch;
  let lastCall = null;
  function installStub() {
    lastCall = null;
    global.fetch = async function (url, opts) {
      lastCall = { url, opts };
      return { ok: true, status: 200, json: async () => ({}) };
    };
  }
  function uninstallStub() {
    global.fetch = realFetch;
    lastCall = null;
  }

  it('throws on DELETE without invoking fetch', async () => {
    installStub();
    try {
      let threw = false;
      try { await safeHealthieFetch('https://api/x', { method: 'DELETE' }); }
      catch (e) { threw = true; assert.match(e.message, /no-DELETE/); }
      assert.equal(threw, true);
      assert.equal(lastCall, null);
    } finally { uninstallStub(); }
  });

  it('allows POST (GraphQL surface)', async () => {
    installStub();
    try {
      const r = await safeHealthieFetch('https://api/graphql', { method: 'POST', body: '{}' });
      assert.equal(r.ok, true);
      assert.equal(lastCall.opts.method, 'POST');
    } finally { uninstallStub(); }
  });

  it('allows GET and defaults to GET when method missing', async () => {
    installStub();
    try {
      const r = await safeHealthieFetch('https://api/x');
      assert.equal(r.ok, true);
    } finally { uninstallStub(); }
  });

  it('HEALTHIE_FORBIDDEN_METHODS only contains DELETE', () => {
    assert.equal(HEALTHIE_FORBIDDEN_METHODS.has('DELETE'), true);
    assert.equal(HEALTHIE_FORBIDDEN_METHODS.has('POST'), false);
    assert.equal(HEALTHIE_FORBIDDEN_METHODS.has('GET'), false);
    assert.equal(HEALTHIE_FORBIDDEN_METHODS.has('PATCH'), false);
    assert.equal(HEALTHIE_FORBIDDEN_METHODS.has('PUT'), false);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildCoalescingFields (Healthie-side; shared semantics with intercom)
// ─────────────────────────────────────────────────────────────────

describe('buildCoalescingFields (Healthie)', () => {
  const NOW_MS = Date.parse('2026-05-18T12:00:00.000Z');

  it('new conversation: primary_task_id null, surface_at = now + HOLD_WINDOW_MS', () => {
    const out = buildCoalescingFields(null, NOW_MS);
    assert.equal(out.primary_task_id, null);
    assert.equal(out.surface_at, new Date(NOW_MS + HOLD_WINDOW_MS).toISOString());
  });

  it('existing primary: primary_task_id set, surface_at null', () => {
    const out = buildCoalescingFields('primary-123', NOW_MS);
    assert.equal(out.primary_task_id, 'primary-123');
    assert.equal(out.surface_at, null);
  });

  it('HOLD_WINDOW_MS matches the intercom adapter (5 minutes)', () => {
    assert.equal(HOLD_WINDOW_MS, 5 * 60 * 1000);
  });
});
