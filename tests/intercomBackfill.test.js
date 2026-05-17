// tests/intercomBackfill.test.js
//
// Unit tests for the pure helpers backing the Intercom conversation
// backfill (added 2026-05-17, "Bundle A" of the conversation-history
// work):
//
//   * extractConversationIdFromExternalId — used by the migration
//     0028 backfill UPDATE and as a fallback at insert time.
//   * buildBackfillRecords — turns an Intercom conversation API
//     response into the array of query_history rows we want to
//     write. Pure; the network call lives in
//     backfillIntercomThread which is not exported.

const {
  extractConversationIdFromExternalId,
  buildBackfillRecords,
} = require('../netlify/functions/intercom.js');

// ─────────────────────────────────────────────────────────────────
// extractConversationIdFromExternalId
// ─────────────────────────────────────────────────────────────────

describe('extractConversationIdFromExternalId', () => {
  it('extracts the conv id from a well-formed Intercom external_id', () => {
    assert.equal(
      extractConversationIdFromExternalId('intercom:conv_abc:part_xyz'),
      'conv_abc'
    );
  });

  it('handles numeric ids (Intercom returns numbers as strings)', () => {
    assert.equal(
      extractConversationIdFromExternalId('intercom:42:88'),
      '42'
    );
  });

  it('returns null for non-string input', () => {
    assert.equal(extractConversationIdFromExternalId(null), null);
    assert.equal(extractConversationIdFromExternalId(undefined), null);
    assert.equal(extractConversationIdFromExternalId(42), null);
    assert.equal(extractConversationIdFromExternalId({}), null);
  });

  it('returns null for non-Intercom external_id formats', () => {
    assert.equal(extractConversationIdFromExternalId('bask:abc:def'), null);
    assert.equal(extractConversationIdFromExternalId('healthie:1234'), null);
    assert.equal(extractConversationIdFromExternalId('manual'), null);
  });

  it('returns null when the format is missing a part segment', () => {
    assert.equal(extractConversationIdFromExternalId('intercom:conv_only'), null);
    assert.equal(extractConversationIdFromExternalId('intercom:'), null);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildBackfillRecords
// ─────────────────────────────────────────────────────────────────

const SAMPLE_CONV = {
  id: 'conv_001',
  created_at: 1700000000,  // unix seconds
  source: {
    id: 'src_001',
    body: '<p>Hi, I have a question about my medication.</p>',
    author: { type: 'user', name: 'Jane Patient', email: 'jane@example.com' },
  },
  conversation_parts: {
    conversation_parts: [
      {
        id: 'part_a',
        body: '<p>Thanks for reaching out — checking on this now.</p>',
        author: { type: 'admin', name: 'Brad (RN)', email: 'brad@clinic.com' },
        created_at: 1700000600,  // 10 min later
      },
      {
        id: 'part_b',
        body: '<p>One more thing — should I take it with food?</p>',
        author: { type: 'user', name: 'Jane Patient', email: 'jane@example.com' },
        created_at: 1700001000,  // ~6 min after that
      },
      {
        id: 'part_c',
        body: null,  // assignment / system part — no body
        author: { type: 'admin', name: 'System' },
        created_at: 1700001100,
      },
      {
        id: 'part_d',
        body: '<p>Yes, take it with food to reduce nausea.</p>',
        author: { type: 'admin', name: 'Brad (RN)', email: 'brad@clinic.com' },
        created_at: 1700001200,
      },
    ],
  },
};

describe('buildBackfillRecords', () => {
  it('produces one record per non-empty part, skipping the current part', () => {
    // skipPartId = 'part_b' (pretend we just inserted that via the webhook)
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'part_b');
    // Expected records: src_001 (user), part_a (admin), part_d (admin).
    // Skipped: part_b (current), part_c (no body).
    assert.equal(recs.length, 3);
  });

  it('records each row with company_id, conversation_id, source_channel intercom, status closed', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    for (const r of recs) {
      assert.equal(r.company_id, 'company-uuid');
      assert.equal(r.conversation_id, 'conv_001');
      assert.equal(r.source_channel, 'intercom');
      assert.equal(r.status, 'closed');
      assert.ok(r.internal_note && r.internal_note.indexOf('BACKFILLED') === 0);
    }
  });

  it('routes user-authored parts to patient_message + NULL actual_response_sent', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    const userRec = recs.find(r => r.external_id === 'intercom:conv_001:src_001');
    assert.ok(userRec, 'should produce a record for the source (initial user message)');
    assert.ok(userRec.patient_message && userRec.patient_message.indexOf('I have a question') !== -1);
    assert.equal(userRec.actual_response_sent, undefined);
  });

  it('captures patient_name + patient_email for user-authored parts', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    const userRec = recs.find(r => r.external_id === 'intercom:conv_001:src_001');
    assert.equal(userRec.patient_name, 'Jane Patient');
    assert.equal(userRec.patient_email, 'jane@example.com');
    // nurse_name must NOT be set on patient-side rows (that column is
    // for the staff member who handles the row).
    assert.equal(userRec.nurse_name, undefined);
  });

  it('routes admin-authored parts to actual_response_sent + NULL patient_message', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    const adminRec = recs.find(r => r.external_id === 'intercom:conv_001:part_a');
    assert.ok(adminRec);
    assert.equal(adminRec.patient_message, undefined);
    assert.ok(adminRec.actual_response_sent && adminRec.actual_response_sent.indexOf('Thanks for reaching out') !== -1);
    assert.equal(adminRec.nurse_name, 'Brad (RN)');
    // patient_name + patient_email must NOT leak onto admin rows.
    assert.equal(adminRec.patient_name, undefined);
    assert.equal(adminRec.patient_email, undefined);
  });

  it('strips HTML from bodies before storing', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    for (const r of recs) {
      const text = r.patient_message || r.actual_response_sent || '';
      assert.equal(text.indexOf('<p>'), -1, 'no <p> tags should survive');
      assert.equal(text.indexOf('</p>'), -1, 'no </p> tags should survive');
    }
  });

  it('sorts the produced records by created_at ascending', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    for (let i = 1; i < recs.length; i++) {
      assert.ok(
        recs[i - 1].created_at <= recs[i].created_at,
        'records must be in ascending order by created_at; got ' +
        JSON.stringify(recs.map(r => r.created_at))
      );
    }
  });

  it('converts unix-seconds created_at into ISO strings', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    for (const r of recs) {
      if (!r.created_at) continue;
      // ISO 8601: e.g. 2023-11-14T22:13:20.000Z
      assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('skips parts whose body is null/empty', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'never');
    // part_c had body: null. Make sure no record references its id.
    assert.equal(recs.find(r => r.external_id === 'intercom:conv_001:part_c'), undefined);
  });

  it('skips the current part (so the webhook insert is not double-written)', () => {
    const recs = buildBackfillRecords(SAMPLE_CONV, 'company-uuid', 'part_b');
    assert.equal(recs.find(r => r.external_id === 'intercom:conv_001:part_b'), undefined);
  });

  it('skips Intercom system placeholder messages', () => {
    const conv = {
      id: 'conv_x',
      created_at: 1,
      source: {
        id: 'src_x',
        body: 'SYSTEM MESSAGE: CONVERSATION STARTED',
        author: { type: 'user' },
      },
      conversation_parts: { conversation_parts: [] },
    };
    const recs = buildBackfillRecords(conv, 'company-uuid', 'never');
    assert.equal(recs.length, 0);
  });

  it('returns [] for null or malformed input', () => {
    assert.deepEqual(buildBackfillRecords(null, 'c', 'x'), []);
    assert.deepEqual(buildBackfillRecords({}, 'c', 'x'), []);
    assert.deepEqual(buildBackfillRecords({ id: null }, 'c', 'x'), []);
  });

  it('handles a conversation with no source object gracefully', () => {
    const conv = {
      id: 'conv_y',
      created_at: 1,
      conversation_parts: {
        conversation_parts: [
          { id: 'p1', body: '<p>only this part</p>', author: { type: 'user' }, created_at: 5 },
        ],
      },
    };
    const recs = buildBackfillRecords(conv, 'company-uuid', 'never');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].external_id, 'intercom:conv_y:p1');
  });

  it('handles a conversation with no conversation_parts gracefully', () => {
    const conv = {
      id: 'conv_z',
      created_at: 1,
      source: {
        id: 'src_z',
        body: '<p>only the source</p>',
        author: { type: 'user' },
      },
    };
    const recs = buildBackfillRecords(conv, 'company-uuid', 'never');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].external_id, 'intercom:conv_z:src_z');
  });
});
