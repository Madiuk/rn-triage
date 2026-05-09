const { parseTriageJSON } = require('../data/triage-lib.js');

describe('parseTriageJSON', () => {
  it('parses a clean JSON object', () => {
    const r = parseTriageJSON('{"urgency":"routine","draft_response":"hi"}');
    assert.equal(r.urgency, 'routine');
    assert.equal(r.draft_response, 'hi');
  });

  it('strips ```json fences', () => {
    const wrapped = '```json\n{"a":1,"b":"two"}\n```';
    const r = parseTriageJSON(wrapped);
    assert.equal(r.a, 1);
    assert.equal(r.b, 'two');
  });

  it('strips bare ``` fences', () => {
    const r = parseTriageJSON('```\n{"a":1}\n```');
    assert.equal(r.a, 1);
  });

  it('falls back to first/last brace when prose surrounds JSON', () => {
    const messy = 'Here is your response:\n{"urgency":"urgent","x":2}\nThanks!';
    const r = parseTriageJSON(messy);
    assert.equal(r.urgency, 'urgent');
    assert.equal(r.x, 2);
  });

  it('throws when no brace found', () => {
    assert.throws(() => parseTriageJSON('not json at all'), /Could not parse/);
  });

  it('handles empty input', () => {
    assert.throws(() => parseTriageJSON(''), /Could not parse/);
  });

  it('handles nested objects', () => {
    const r = parseTriageJSON('{"a":{"b":{"c":1}}}');
    assert.equal(r.a.b.c, 1);
  });
});
