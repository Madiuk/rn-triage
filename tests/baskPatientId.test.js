// tests/baskPatientId.test.js
//
// Unit tests for the Bask patient ID extraction added in migration 0034.
//
// Bask creates Intercom contacts with the patient's Bask ID stored in
// the contact-level external_id field. Every Intercom webhook ships
// this value at data.item.contacts.contacts[0].external_id; we pull
// it once at insert time and persist as query_history.bask_patient_id
// so the SPA can render a "Bask record →" link without an API
// round-trip.
//
// Two surfaces covered here:
//   * extractBaskPatientId(payload) — the pure helper.
//   * extractMessage(payload) — verifies it threads baskPatientId
//     through to the returned message object on both the
//     conversation.user.created and conversation.user.replied paths.

const {
  extractBaskPatientId,
  extractMessage,
} = require('../netlify/functions/intercom.js');

describe('extractBaskPatientId', () => {
  it('returns the contact external_id when present', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ external_id: '4707590' }] } } },
    };
    assert.equal(extractBaskPatientId(payload), '4707590');
  });

  it('trims whitespace from the id', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ external_id: '  4707590  ' }] } } },
    };
    assert.equal(extractBaskPatientId(payload), '4707590');
  });

  it('returns null when contacts array is empty', () => {
    const payload = {
      data: { item: { contacts: { contacts: [] } } },
    };
    assert.equal(extractBaskPatientId(payload), null);
  });

  it('returns null when contacts is missing', () => {
    const payload = { data: { item: {} } };
    assert.equal(extractBaskPatientId(payload), null);
  });

  it('returns null when item is missing', () => {
    assert.equal(extractBaskPatientId({ data: {} }), null);
  });

  it('returns null when payload is null/undefined', () => {
    assert.equal(extractBaskPatientId(null), null);
    assert.equal(extractBaskPatientId(undefined), null);
  });

  it('returns null when external_id is empty/whitespace', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ external_id: '' }] } } },
    };
    assert.equal(extractBaskPatientId(payload), null);

    const payload2 = {
      data: { item: { contacts: { contacts: [{ external_id: '   ' }] } } },
    };
    assert.equal(extractBaskPatientId(payload2), null);
  });

  it('returns null when external_id is not a string', () => {
    const payload = {
      data: { item: { contacts: { contacts: [{ external_id: 4707590 }] } } },
    };
    assert.equal(extractBaskPatientId(payload), null);
  });

  it('ignores additional contacts beyond the first', () => {
    // Intercom conversations rarely carry multiple contacts, but if
    // they did the primary one we care about is the first.
    const payload = {
      data: {
        item: {
          contacts: {
            contacts: [
              { external_id: '4707590' },
              { external_id: 'ignored' },
            ],
          },
        },
      },
    };
    assert.equal(extractBaskPatientId(payload), '4707590');
  });
});

describe('extractMessage — baskPatientId threading', () => {
  it('includes baskPatientId on conversation.user.created', () => {
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
          contacts: { contacts: [{ external_id: '4707590' }] },
        },
      },
    };
    const out = extractMessage(payload);
    assert.equal(out.baskPatientId, '4707590');
    assert.equal(out.conversationId, 'conv_1');
    assert.equal(out.partId, 'part_1');
  });

  it('includes baskPatientId on conversation.user.replied', () => {
    const payload = {
      topic: 'conversation.user.replied',
      data: {
        item: {
          id: 'conv_1',
          conversation_parts: {
            conversation_parts: [
              {
                id: 'part_2',
                body: 'follow up',
                author: { type: 'user', email: 'p@example.com', name: 'Pat' },
              },
            ],
          },
          contacts: { contacts: [{ external_id: '4664396' }] },
        },
      },
    };
    const out = extractMessage(payload);
    assert.equal(out.baskPatientId, '4664396');
  });

  it('returns null baskPatientId when contacts are missing (non-Bask channel)', () => {
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
    assert.equal(out.baskPatientId, null);
  });
});
