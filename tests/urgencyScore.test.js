const { computeUrgencyScore, formatDuration, levenshteinDistance } = require('../data/triage-lib.js');

describe('computeUrgencyScore', () => {
  it('routine + no side effect = 3', () => {
    assert.equal(computeUrgencyScore('routine', 'none', false), 3);
  });

  it('same-day + no side effect = 6', () => {
    assert.equal(computeUrgencyScore('same-day', 'none', false), 6);
  });

  it('urgent + no side effect = 9', () => {
    assert.equal(computeUrgencyScore('urgent', 'none', false), 9);
  });

  it('urgent + severe side effect caps at 10', () => {
    assert.equal(computeUrgencyScore('urgent', 'severe', true), 10);
  });

  it('same-day + moderate side effect = 7', () => {
    assert.equal(computeUrgencyScore('same-day', 'moderate', true), 7);
  });

  it('routine + mild side effect = 3 (no boost)', () => {
    assert.equal(computeUrgencyScore('routine', 'mild', true), 3);
  });

  it('hasSideEffect=false ignores routingLevel', () => {
    assert.equal(computeUrgencyScore('same-day', 'severe', false), 6);
  });
});

describe('formatDuration', () => {
  it('returns em-dash for null/zero/negative', () => {
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(0), '—');
    assert.equal(formatDuration(-5), '—');
  });

  it('formats seconds under a minute', () => {
    assert.equal(formatDuration(12), '12s');
    assert.equal(formatDuration(59), '59s');
  });

  it('formats minutes only when no remainder', () => {
    assert.equal(formatDuration(60), '1m');
    assert.equal(formatDuration(120), '2m');
  });

  it('formats minutes + seconds otherwise', () => {
    assert.equal(formatDuration(75), '1m 15s');
    assert.equal(formatDuration(125), '2m 5s');
  });
});

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshteinDistance('hello', 'hello'), 0);
  });

  it('returns length for empty input', () => {
    assert.equal(levenshteinDistance('', 'abc'), 3);
    assert.equal(levenshteinDistance('abc', ''), 3);
  });

  it('counts single substitution', () => {
    assert.equal(levenshteinDistance('cat', 'bat'), 1);
  });

  it('counts insertion', () => {
    assert.equal(levenshteinDistance('cat', 'cats'), 1);
  });

  it('counts deletion', () => {
    assert.equal(levenshteinDistance('cats', 'cat'), 1);
  });

  it('handles longer edits', () => {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
  });

  it('treats null inputs as empty', () => {
    assert.equal(levenshteinDistance(null, 'abc'), 3);
    assert.equal(levenshteinDistance('abc', null), 3);
  });
});
