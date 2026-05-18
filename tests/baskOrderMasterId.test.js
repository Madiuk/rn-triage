// tests/baskOrderMasterId.test.js
//
// Unit tests for the second-deep-link enrichment added in migration 0035:
//
//   * extractIntercomContactId(payload) — pulls the Intercom-side
//     contact id (not the external_id / Bask patient id) from a
//     webhook payload. Persisted as query_history.intercom_contact_id
//     so the per-conversation enrichment + the one-off backfill can
//     call GET /contacts/{id} directly without an external_id search.
//
//   * extractBaskOrderMasterId(intercomContact) — given the JSON
//     returned by Intercom's GET /contacts/{id}, pulls the order
//     Master ID out of custom_attributes["order id"]. Bask uses this
//     UUID for the admin/orders/<id> URL pattern.

const {
  extractIntercomContactId,
  extractBaskOrderMasterId,
  extractMessage,
} = require('../netlify/functions/intercom.js');

// ─────────────────────────────────────────────────────────────────
// extractIntercomContactId
// ─────────────────────────────────────────────────────────────────

describe('extractIntercomContactId', () => {
  it('returns the contact id when present', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ id: '6a0a7f7871c4ad790a391f10' }] } } },
    };
    assert.equal(extractIntercomContactId(payload), '6a0a7f7871c4ad790a391f10');
  });

  it('does NOT confuse with external_id (Bask patient id)', () => {
    const payload = {
      data: {
        item: {
          contacts: {
            contacts: [{ id: 'intercom_id_1', external_id: '4707590' }],
          },
        },
      },
    };
    assert.equal(extractIntercomContactId(payload), 'intercom_id_1');
  });

  it('trims whitespace from the id', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ id: '  abc  ' }] } } },
    };
    assert.equal(extractIntercomContactId(payload), 'abc');
  });

  it('returns null when contacts array is empty', () => {
    assert.equal(extractIntercomContactId(
      { data: { item: { contacts: { contacts: [] } } } }
    ), null);
  });

  it('returns null when contacts is missing', () => {
    assert.equal(extractIntercomContactId({ data: { item: {} } }), null);
  });

  it('returns null on null / undefined payload', () => {
    assert.equal(extractIntercomContactId(null), null);
    assert.equal(extractIntercomContactId(undefined), null);
  });

  it('returns null when id is empty / whitespace / non-string', () => {
    assert.equal(extractIntercomContactId(
      { data: { item: { contacts: { contacts: [{ id: '' }] } } } }
    ), null);
    assert.equal(extractIntercomContactId(
      { data: { item: { contacts: { contacts: [{ id: '   ' }] } } } }
    ), null);
    assert.equal(extractIntercomContactId(
      { data: { item: { contacts: { contacts: [{ id: 12345 }] } } } }
    ), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// extractBaskOrderMasterId
// ─────────────────────────────────────────────────────────────────

describe('extractBaskOrderMasterId', () => {
  it('returns the master id from custom_attributes["order id"]', () => {
    const contact = {
      custom_attributes: {
        'order id': '523da690-873e-4541-878b-555c45b2e596',
        zipcode: '80634',
      },
    };
    assert.equal(
      extractBaskOrderMasterId(contact),
      '523da690-873e-4541-878b-555c45b2e596'
    );
  });

  it('trims whitespace', () => {
    const contact = { custom_attributes: { 'order id': '  abc-uuid  ' } };
    assert.equal(extractBaskOrderMasterId(contact), 'abc-uuid');
  });

  it('matches the exact "order id" key (lowercase, with a space)', () => {
    // The key has a space — verify we don't accidentally match
    // alternate spellings that Bask might use elsewhere.
    const wrongKey = { custom_attributes: { 'order_id': 'should-not-match' } };
    assert.equal(extractBaskOrderMasterId(wrongKey), null);
    const wrongCase = { custom_attributes: { 'Order ID': 'should-not-match' } };
    assert.equal(extractBaskOrderMasterId(wrongCase), null);
  });

  it('returns null when custom_attributes is missing or empty', () => {
    assert.equal(extractBaskOrderMasterId({}), null);
    assert.equal(extractBaskOrderMasterId({ custom_attributes: {} }), null);
  });

  it('returns null when the value is empty / whitespace / non-string', () => {
    assert.equal(extractBaskOrderMasterId(
      { custom_attributes: { 'order id': '' } }
    ), null);
    assert.equal(extractBaskOrderMasterId(
      { custom_attributes: { 'order id': '   ' } }
    ), null);
    assert.equal(extractBaskOrderMasterId(
      { custom_attributes: { 'order id': null } }
    ), null);
    assert.equal(extractBaskOrderMasterId(
      { custom_attributes: { 'order id': 42 } }
    ), null);
  });

  it('returns null on null / undefined input', () => {
    assert.equal(extractBaskOrderMasterId(null), null);
    assert.equal(extractBaskOrderMasterId(undefined), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// extractMessage — intercomContactId threading
// ─────────────────────────────────────────────────────────────────

describe('extractMessage — intercomContactId threading', () => {
  it('includes intercomContactId on conversation.user.created', () => {
    const payload = {
      topic: 'conversation.user.created',
      data: {
        item: {
          id: 'conv_1',
          source: {
            id: 'part_1',
            body: 'hello',
            author: { email: 'p@example.com', name: 'Pat' },
          },
          contacts: {
            contacts: [{ id: 'intercom_xyz', external_id: '4707590' }],
          },
        },
      },
    };
    const out = extractMessage(payload);
    assert.equal(out.intercomContactId, 'intercom_xyz');
    assert.equal(out.baskPatientId, '4707590');
  });

  it('includes intercomContactId on conversation.user.replied', () => {
    const payload = {
      topic: 'conversation.user.replied',
      data: {
        item: {
          id: 'conv_1',
          conversation_parts: {
            conversation_parts: [
              {
                id: 'part_2',
                body: 'follow-up',
                author: { type: 'user', email: 'p@example.com', name: 'Pat' },
              },
            ],
          },
          contacts: { contacts: [{ id: 'intercom_abc' }] },
        },
      },
    };
    const out = extractMessage(payload);
    assert.equal(out.intercomContactId, 'intercom_abc');
  });

  it('returns null intercomContactId when contacts are missing', () => {
    const payload = {
      topic: 'conversation.user.created',
      data: {
        item: {
          id: 'conv_1',
          source: {
            id: 'part_1',
            body: 'hello',
            author: { email: 'p@example.com', name: 'Pat' },
          },
        },
      },
    };
    const out = extractMessage(payload);
    assert.equal(out.intercomContactId, null);
  });
});
