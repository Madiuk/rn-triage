const { classifyMessage } = require('../data/triage-lib.js');

describe('classifyMessage', () => {
  it('always includes rules and routing', () => {
    const types = classifyMessage('hello');
    assert.ok(types.includes('rules'));
    assert.ok(types.includes('routing'));
  });

  it('detects nausea as a side effect', () => {
    const types = classifyMessage('I have terrible nausea');
    assert.ok(types.includes('sideeffects'));
    assert.ok(types.includes('protocols'));
  });

  it('detects vomiting as a side effect', () => {
    const types = classifyMessage('I have been vomiting for two days');
    assert.ok(types.includes('sideeffects'));
  });

  it('detects weight plateau and adds templates + urls', () => {
    const types = classifyMessage('My weight has plateaued for 3 weeks');
    assert.ok(types.includes('templates'));
    assert.ok(types.includes('urls'));
  });

  it('detects dosing question and adds protocols', () => {
    const types = classifyMessage('I missed my dose yesterday, what should I do?');
    assert.ok(types.includes('protocols'));
  });

  it('detects non-clinical billing and adds routing_detail', () => {
    const types = classifyMessage('I was charged twice on my credit card');
    assert.ok(types.includes('routing_detail'));
  });

  it('detects shipping and adds routing_detail', () => {
    const types = classifyMessage('Where is my package, the tracking has not updated');
    assert.ok(types.includes('routing_detail'));
  });

  it('falls back to sideeffects when nothing else matches', () => {
    const types = classifyMessage('hello can you help me');
    assert.ok(types.includes('sideeffects'));
  });

  it('returns deduplicated types', () => {
    const types = classifyMessage('I have nausea and vomiting');
    const seen = new Set();
    types.forEach(t => { assert.ok(!seen.has(t), 'duplicate ' + t); seen.add(t); });
  });

  it('handles empty input', () => {
    const types = classifyMessage('');
    assert.ok(types.includes('rules'));
    assert.ok(types.includes('routing'));
  });

  it('detects pancreatitis red flag (severe pain)', () => {
    const types = classifyMessage('I have severe abdominal pain radiating to my back');
    assert.ok(types.includes('sideeffects'));
    assert.ok(types.includes('protocols'));
  });

  it('detects shipping AND side effect together (dual task)', () => {
    const types = classifyMessage('My order is late and I have nausea');
    assert.ok(types.includes('routing_detail'));
    assert.ok(types.includes('sideeffects'));
  });
});
