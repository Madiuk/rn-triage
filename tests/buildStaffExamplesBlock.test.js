// tests/buildStaffExamplesBlock.test.js
//
// Pins byte-identical output between data/triage-lib.js's
// buildStaffExamplesBlock and the combined effect of
// app.js's loadStaffExamples filter + getStaffExamplesBlock format.
//
// Same parity rationale as buildFullKB.test.js: when the proxy
// assembles this block server-side, every byte must match the
// client's prior output so kb_version hashes (and Anthropic prompt
// cache hits where applicable — this block is intentionally uncached
// per app.js:1185-1187 so cache hits don't apply here, but byte
// parity still matters for prompt-quality regression tracking).

const { buildStaffExamplesBlock } = require('../data/triage-lib');

// Fixture: one fully-qualifying row. Used as the baseline shape.
function goodRow(over) {
  const base = {
    patient_message: 'I have been feeling nauseous since starting the medication last Tuesday and not sure if I should stop.',
    draft_response: 'Try taking it with food and see if that helps.',
    actual_response_sent: 'Hey — sorry you are feeling that way. Take it with food next time. If it keeps up, message us back.',
    edit_distance: 80,
  };
  return Object.assign(base, over || {});
}

describe('buildStaffExamplesBlock', () => {
  it('returns empty string for empty / non-array input', () => {
    assert.equal(buildStaffExamplesBlock([]), '');
    assert.equal(buildStaffExamplesBlock(null), '');
    assert.equal(buildStaffExamplesBlock(undefined), '');
    assert.equal(buildStaffExamplesBlock({ not: 'an array' }), '');
  });

  it('filters out rows missing actual_response_sent', () => {
    const rows = [goodRow({ actual_response_sent: null })];
    assert.equal(buildStaffExamplesBlock(rows), '');
  });

  it('filters out rows missing draft_response', () => {
    const rows = [goodRow({ draft_response: null })];
    assert.equal(buildStaffExamplesBlock(rows), '');
  });

  it('filters out rows missing patient_message', () => {
    const rows = [goodRow({ patient_message: null })];
    assert.equal(buildStaffExamplesBlock(rows), '');
  });

  it('filters out rows with edit_distance < 40', () => {
    const rows = [goodRow({ edit_distance: 39 })];
    assert.equal(buildStaffExamplesBlock(rows), '');
  });

  it('keeps rows with edit_distance == null (legacy pre-column rows)', () => {
    // Matches app.js line 293-294 — null edit_distance is treated as
    // qualifying, on the assumption it's a legacy row not a trivial edit.
    const rows = [goodRow({ edit_distance: null })];
    const out = buildStaffExamplesBlock(rows);
    assert.ok(out.length > 0, 'legacy null-edit_distance rows must qualify');
    assert.ok(out.includes('EXAMPLE 1\n'));
  });

  it('filters out rows where patient_message is < 20 chars', () => {
    const rows = [goodRow({ patient_message: 'too short' })];
    assert.equal(buildStaffExamplesBlock(rows), '');
  });

  it('takes only the first 3 qualifying rows (preserves input order)', () => {
    const rows = [
      goodRow({ patient_message: 'first message that is well over twenty chars' }),
      goodRow({ patient_message: 'second message that is well over twenty chars' }),
      goodRow({ patient_message: 'third message that is well over twenty chars' }),
      goodRow({ patient_message: 'fourth message that is well over twenty chars' }),
    ];
    const out = buildStaffExamplesBlock(rows);
    assert.ok(out.includes('EXAMPLE 1\n'));
    assert.ok(out.includes('EXAMPLE 2\n'));
    assert.ok(out.includes('EXAMPLE 3\n'));
    assert.ok(!out.includes('EXAMPLE 4\n'), 'fourth qualifying row must be dropped');
    assert.ok(out.indexOf('first message')  < out.indexOf('second message'), 'order preserved');
    assert.ok(out.indexOf('second message') < out.indexOf('third message'), 'order preserved');
  });

  it('formats one example with the exact preamble and JSON.stringify-wrapped fields', () => {
    const rows = [goodRow({
      patient_message: 'I have been feeling unwell for a week now.',
      draft_response: 'Have you taken any medication?',
      actual_response_sent: 'Sorry to hear that. What symptoms specifically?',
      edit_distance: 50,
    })];
    const out = buildStaffExamplesBlock(rows);
    // The byte-exact expected output. If a single character drifts
    // between this and app.js's getStaffExamplesBlock, the proxy and
    // client will disagree on what to send Anthropic.
    const expected =
      '=== RECENT STAFF EDITS -- match this voice in draft_response ===\n' +
      'These are real corrections from your team. The "what the nurse actually sent" version is what you should emulate: tone, sentence length, word choice, contractions, line breaks. The AI draft is shown for contrast so you can see the delta. Apply this voice to draft_response below. Match the nurse, not the prior AI.\n\n' +
      'EXAMPLE 1\n' +
      'Patient message: "I have been feeling unwell for a week now.\"\n' +
      'AI draft (what you would have written): "Have you taken any medication?\"\n' +
      'What the nurse actually sent: "Sorry to hear that. What symptoms specifically?\"';
    assert.equal(out, expected);
  });

  it('JSON-escapes embedded quotes and newlines', () => {
    // Patient messages routinely contain quotes and line breaks. The
    // JSON.stringify wrapper handles this; the test ensures the format
    // doesn't break on it.
    const rows = [goodRow({
      patient_message: 'She said "I feel sick"\nand then went to bed.',
      draft_response: 'OK',
      actual_response_sent: 'Got it — keeping an eye on her overnight is wise.',
      edit_distance: 50,
    })];
    const out = buildStaffExamplesBlock(rows);
    assert.ok(out.includes('Patient message: "She said \\"I feel sick\\"\\nand then went to bed."'),
      'quotes and newlines in patient_message must be JSON-escaped, not literal');
  });

  it('joins multiple examples with double newline (no trailing newline)', () => {
    const rows = [
      goodRow({ patient_message: 'first example that is long enough to qualify' }),
      goodRow({ patient_message: 'second example that is long enough to qualify' }),
    ];
    const out = buildStaffExamplesBlock(rows);
    assert.ok(out.includes('EXAMPLE 1\n'));
    assert.ok(out.includes('EXAMPLE 2\n'));
    // Verify the inter-example separator is exactly \n\n (not \n\n\n).
    const ex1End = out.indexOf('What the nurse actually sent:');
    const between = out.slice(ex1End).match(/\n+EXAMPLE 2/);
    assert.ok(between, 'EXAMPLE 2 must follow EXAMPLE 1');
    assert.equal(between[0], '\n\nEXAMPLE 2', 'separator must be exactly \\n\\n');
    assert.ok(!out.endsWith('\n'), 'no trailing newline');
  });
});
