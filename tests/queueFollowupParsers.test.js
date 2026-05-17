// tests/queueFollowupParsers.test.js
//
// Unit tests for the body-parser helpers backing the follow-up
// task flow added 2026-05-17:
//
//   * parseCloseNoReplyBody — POST /queue/close-no-reply
//   * parseSpawnFollowupBody — POST /queue/spawn-followup
//
// Like the other queue parsers (parseSendBody, parseReassignBody,
// etc.), these are exported pure functions. Test them directly
// rather than spinning up the handler chain.

const {
  parseCloseNoReplyBody,
  parseSpawnFollowupBody,
} = require('../netlify/functions/_lib/routes/queue.js');

// ─────────────────────────────────────────────────────────────────
// parseCloseNoReplyBody
// ─────────────────────────────────────────────────────────────────

describe('parseCloseNoReplyBody', () => {
  it('accepts a valid body with triage_id + note', () => {
    const r = parseCloseNoReplyBody({
      triage_id: '11111111-2222-3333-4444-555555555555',
      note: 'Patient acknowledged the recommendation — no action needed.',
    });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, '11111111-2222-3333-4444-555555555555');
    assert.equal(r.note, 'Patient acknowledged the recommendation — no action needed.');
  });

  it('rejects a non-object body', () => {
    assert.equal(parseCloseNoReplyBody(null).ok, false);
    assert.equal(parseCloseNoReplyBody(undefined).ok, false);
    assert.equal(parseCloseNoReplyBody('not an object').ok, false);
  });

  it('requires triage_id', () => {
    const r = parseCloseNoReplyBody({ note: 'valid note' });
    assert.equal(r.ok, false);
    assert.ok(/triage_id/.test(r.error));
  });

  it('rejects empty triage_id (only whitespace)', () => {
    const r = parseCloseNoReplyBody({ triage_id: '   ', note: 'valid' });
    assert.equal(r.ok, false);
    assert.ok(/triage_id/.test(r.error));
  });

  it('requires note', () => {
    const r = parseCloseNoReplyBody({ triage_id: 'abc' });
    assert.equal(r.ok, false);
    assert.ok(/note/.test(r.error));
  });

  it('rejects empty note (only whitespace)', () => {
    const r = parseCloseNoReplyBody({ triage_id: 'abc', note: '\n\t  ' });
    assert.equal(r.ok, false);
    assert.ok(/note/.test(r.error));
  });

  it('rejects note exceeding 4000 chars', () => {
    const note = 'a'.repeat(4001);
    const r = parseCloseNoReplyBody({ triage_id: 'abc', note: note });
    assert.equal(r.ok, false);
    assert.ok(/4000/.test(r.error));
  });

  it('accepts note at exactly 4000 chars (boundary)', () => {
    const note = 'a'.repeat(4000);
    const r = parseCloseNoReplyBody({ triage_id: 'abc', note: note });
    assert.equal(r.ok, true);
  });

  it('trims surrounding whitespace from triage_id and note', () => {
    const r = parseCloseNoReplyBody({ triage_id: '  abc  ', note: '  hello  ' });
    assert.equal(r.ok, true);
    assert.equal(r.triageId, 'abc');
    assert.equal(r.note, 'hello');
  });
});

// ─────────────────────────────────────────────────────────────────
// parseSpawnFollowupBody
// ─────────────────────────────────────────────────────────────────

describe('parseSpawnFollowupBody', () => {
  it('accepts a valid body with all fields', () => {
    const r = parseSpawnFollowupBody({
      parent_id: 'parent-uuid',
      target_category: 'Refill Request',
      note: 'Patient also asked about refill timing.',
      draft_response: 'Hi — I will process your refill shortly.',
      patient_facing: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.parentId, 'parent-uuid');
    assert.equal(r.targetCategory, 'Refill Request');
    assert.equal(r.note, 'Patient also asked about refill timing.');
    assert.equal(r.draftResponse, 'Hi — I will process your refill shortly.');
    assert.equal(r.patientFacing, true);
  });

  it('accepts a minimal body (no draft, no explicit patient_facing)', () => {
    const r = parseSpawnFollowupBody({
      parent_id: 'p',
      target_category: 'Billing',
      note: 'Patient asked about an invoice.',
    });
    assert.equal(r.ok, true);
    // patient_facing defaults to true per the 2026-05-17 design choice
    assert.equal(r.patientFacing, true);
    // draft_response defaults to empty string
    assert.equal(r.draftResponse, '');
  });

  it('coerces patient_facing=false correctly (only literal false flips it off)', () => {
    assert.equal(parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c', note: 'n', patient_facing: false }).patientFacing, false);
    // Anything else coerces to true (default).
    assert.equal(parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c', note: 'n', patient_facing: 0 }).patientFacing, true);
    assert.equal(parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c', note: 'n', patient_facing: 'false' }).patientFacing, true);
    assert.equal(parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c', note: 'n', patient_facing: null }).patientFacing, true);
  });

  it('rejects a non-object body', () => {
    assert.equal(parseSpawnFollowupBody(null).ok, false);
    assert.equal(parseSpawnFollowupBody('x').ok, false);
  });

  it('requires parent_id', () => {
    const r = parseSpawnFollowupBody({ target_category: 'c', note: 'n' });
    assert.equal(r.ok, false);
    assert.ok(/parent_id/.test(r.error));
  });

  it('requires target_category', () => {
    const r = parseSpawnFollowupBody({ parent_id: 'p', note: 'n' });
    assert.equal(r.ok, false);
    assert.ok(/target_category/.test(r.error));
  });

  it('requires note', () => {
    const r = parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c' });
    assert.equal(r.ok, false);
    assert.ok(/note/.test(r.error));
  });

  it('rejects note exceeding 4000 chars', () => {
    const note = 'a'.repeat(4001);
    const r = parseSpawnFollowupBody({ parent_id: 'p', target_category: 'c', note: note });
    assert.equal(r.ok, false);
    assert.ok(/4000/.test(r.error));
  });

  it('rejects draft_response exceeding 50000 chars', () => {
    const draft = 'a'.repeat(50001);
    const r = parseSpawnFollowupBody({
      parent_id: 'p', target_category: 'c', note: 'n',
      draft_response: draft,
    });
    assert.equal(r.ok, false);
    assert.ok(/50000/.test(r.error));
  });

  it('trims whitespace from parent_id, target_category, note', () => {
    const r = parseSpawnFollowupBody({
      parent_id: '  p  ',
      target_category: '  cat  ',
      note: '  n  ',
    });
    assert.equal(r.ok, true);
    assert.equal(r.parentId, 'p');
    assert.equal(r.targetCategory, 'cat');
    assert.equal(r.note, 'n');
  });
});
