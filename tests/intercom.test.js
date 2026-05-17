const crypto = require('crypto');
const { verifyIntercomSignature, stripHtml, extractMessage, isAiAgentParticipated } = require('../netlify/functions/intercom.js');

describe('verifyIntercomSignature', () => {
  const secret = 'test-secret-for-hmac-verification';
  const body = '{"topic":"conversation.user.created","data":{"item":{"id":"abc"}}}';
  const sha1Sig    = 'sha1='   + crypto.createHmac('sha1',   secret).update(body).digest('hex');
  const sha256Sig  = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid SHA-1 signature', () => {
    assert.equal(verifyIntercomSignature(body, sha1Sig, secret), true);
  });

  it('accepts a valid SHA-256 signature', () => {
    assert.equal(verifyIntercomSignature(body, sha256Sig, secret), true);
  });

  it('rejects a tampered body', () => {
    assert.equal(verifyIntercomSignature(body + 'x', sha1Sig, secret), false);
  });

  it('rejects a wrong secret', () => {
    assert.equal(verifyIntercomSignature(body, sha1Sig, secret + 'x'), false);
  });

  it('rejects a signature with no algorithm prefix', () => {
    assert.equal(verifyIntercomSignature(body, 'just-a-hex-string', secret), false);
  });

  it('rejects empty / null signature', () => {
    assert.equal(verifyIntercomSignature(body, '', secret), false);
    assert.equal(verifyIntercomSignature(body, null, secret), false);
    assert.equal(verifyIntercomSignature(body, undefined, secret), false);
  });

  it('rejects empty / null secret', () => {
    assert.equal(verifyIntercomSignature(body, sha1Sig, ''), false);
    assert.equal(verifyIntercomSignature(body, sha1Sig, null), false);
  });

  it('rejects mismatched length signatures (defense against truncation)', () => {
    // A signature whose hex length doesn't match the expected digest
    // should fail before timingSafeEqual gets called.
    assert.equal(verifyIntercomSignature(body, 'sha1=deadbeef', secret), false);
  });

  it('rejects malformed hex in the signature', () => {
    assert.equal(verifyIntercomSignature(body, 'sha1=not-hex-zzz', secret), false);
  });
});

describe('stripHtml', () => {
  it('removes basic block tags', () => {
    assert.equal(stripHtml('<p>Hello world</p>'), 'Hello world');
    assert.equal(stripHtml('<div>Hi <span>there</span></div>'), 'Hi there');
  });

  it('converts <br> variants to newlines', () => {
    assert.equal(stripHtml('Line 1<br>Line 2'),    'Line 1\nLine 2');
    assert.equal(stripHtml('Line 1<br/>Line 2'),   'Line 1\nLine 2');
    assert.equal(stripHtml('Line 1<br />Line 2'),  'Line 1\nLine 2');
    assert.equal(stripHtml('Line 1<BR>Line 2'),    'Line 1\nLine 2');
  });

  it('converts closing block tags to newlines (preserves paragraph breaks)', () => {
    assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One\n\nTwo');
    assert.equal(stripHtml('<li>a</li><li>b</li>'),  'a\nb');
  });

  it('decodes common HTML entities', () => {
    assert.equal(stripHtml('Tom &amp; Jerry'),              'Tom & Jerry');
    assert.equal(stripHtml('She said &quot;hi&quot;'),      'She said "hi"');
    assert.equal(stripHtml("It&#39;s fine"),                "It's fine");
    assert.equal(stripHtml('Hello&nbsp;world'),             'Hello world');
    assert.equal(stripHtml('&lt;script&gt;'),               '<script>');
  });

  it('collapses 3+ consecutive newlines into 2', () => {
    assert.equal(stripHtml('<p>One</p><p></p><p></p><p>Two</p>'), 'One\n\nTwo');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(stripHtml('  <p>middle</p>  '), 'middle');
  });

  it('handles empty / null / undefined input', () => {
    assert.equal(stripHtml(''), '');
    assert.equal(stripHtml(null), '');
    assert.equal(stripHtml(undefined), '');
    assert.equal(stripHtml(42), '');
  });

  it('handles a realistic Intercom payload body', () => {
    const html = '<p>Hi! I\'ve been experiencing <strong>nausea</strong> since I started.</p>' +
                 '<p>Is this normal? It&#39;s been about 3 days.</p>';
    assert.equal(
      stripHtml(html),
      "Hi! I've been experiencing nausea since I started.\n\nIs this normal? It's been about 3 days."
    );
  });
});

describe('extractMessage', () => {
  it('extracts a new conversation message', () => {
    const payload = {
      topic: 'conversation.user.created',
      data: {
        item: {
          id: 'conv-123',
          source: {
            id: 'src-456',
            body: '<p>I have nausea</p>',
            author: { type: 'user', email: 'jane@example.com', name: 'Jane Doe' },
          },
        },
      },
    };
    const r = extractMessage(payload);
    assert.equal(r.conversationId, 'conv-123');
    assert.equal(r.partId, 'src-456');
    assert.equal(r.messageHtml, '<p>I have nausea</p>');
    assert.equal(r.authorEmail, 'jane@example.com');
    assert.equal(r.authorName, 'Jane Doe');
  });

  it('falls back to conversation id when source.id is missing', () => {
    const payload = {
      topic: 'conversation.user.created',
      data: { item: { id: 'conv-only', source: { body: 'hi', author: { type: 'user' } } } },
    };
    const r = extractMessage(payload);
    assert.equal(r.partId, 'conv-only');
  });

  it('extracts the latest user reply on a thread (ignores admin parts)', () => {
    const payload = {
      topic: 'conversation.user.replied',
      data: {
        item: {
          id: 'conv-789',
          conversation_parts: {
            conversation_parts: [
              { id: 'p1', author: { type: 'user', name: 'Pat' }, body: 'first user msg' },
              { id: 'p2', author: { type: 'admin', name: 'Nurse' }, body: 'admin response' },
              { id: 'p3', author: { type: 'user', name: 'Pat' }, body: 'follow-up question' },
            ],
          },
        },
      },
    };
    const r = extractMessage(payload);
    assert.equal(r.partId, 'p3');
    assert.equal(r.messageHtml, 'follow-up question');
    assert.equal(r.authorName, 'Pat');
  });

  it('returns null when a reply event has no user-authored part', () => {
    const payload = {
      topic: 'conversation.user.replied',
      data: {
        item: {
          id: 'conv-x',
          conversation_parts: {
            conversation_parts: [
              { id: 'p1', author: { type: 'admin' }, body: 'admin only' },
            ],
          },
        },
      },
    };
    assert.equal(extractMessage(payload), null);
  });

  it('returns null when conversation_parts is missing on a reply event', () => {
    const payload = {
      topic: 'conversation.user.replied',
      data: { item: { id: 'conv-x' } },
    };
    assert.equal(extractMessage(payload), null);
  });

  it('returns null for unsupported topics', () => {
    assert.equal(extractMessage({ topic: 'conversation.admin.created', data: { item: { id: 'x' } } }), null);
    assert.equal(extractMessage({ topic: 'something_random', data: { item: { id: 'x' } } }), null);
  });

  it('handles missing/null data gracefully', () => {
    assert.equal(extractMessage(null), null);
    assert.equal(extractMessage({}), null);
    assert.equal(extractMessage({ topic: 'conversation.user.created' }), null);
    assert.equal(extractMessage({ topic: 'conversation.user.created', data: {} }), null);
  });
});

describe('isAiAgentParticipated', () => {
  it('returns true when the flag is true on the conversation item', () => {
    const payload = { topic: 'conversation.user.replied', data: { item: { id: 'c1', ai_agent_participated: true } } };
    assert.equal(isAiAgentParticipated(payload), true);
  });

  it('returns false when the flag is explicitly false', () => {
    const payload = { topic: 'conversation.user.replied', data: { item: { id: 'c1', ai_agent_participated: false } } };
    assert.equal(isAiAgentParticipated(payload), false);
  });

  it('returns false when the flag is missing from the item', () => {
    const payload = { topic: 'conversation.user.replied', data: { item: { id: 'c1' } } };
    assert.equal(isAiAgentParticipated(payload), false);
  });

  it('returns false when item is missing', () => {
    assert.equal(isAiAgentParticipated({ topic: 'x', data: {} }), false);
  });

  it('returns false when data is missing', () => {
    assert.equal(isAiAgentParticipated({ topic: 'x' }), false);
  });

  it('returns false for null / undefined input', () => {
    assert.equal(isAiAgentParticipated(null), false);
    assert.equal(isAiAgentParticipated(undefined), false);
  });

  // Strict equality with `true` — only the boolean true counts. A
  // string 'true' or a numeric 1 must NOT trigger the routing change;
  // we only react when Intercom sends an actual boolean.
  it('returns false for truthy-but-not-strict-true values', () => {
    assert.equal(isAiAgentParticipated({ data: { item: { ai_agent_participated: 1 } } }), false);
    assert.equal(isAiAgentParticipated({ data: { item: { ai_agent_participated: 'true' } } }), false);
  });
});
