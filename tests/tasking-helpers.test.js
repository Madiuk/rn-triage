// tests/tasking-helpers.test.js
//
// Unit tests for tasking-helpers.js. The SPA uses these helpers to
// translate /worker invocation responses into user-facing toast text.
// Worker response shape variants are pinned by tests/worker.test.js
// (the buildTriagePatch tests); this file pins the UI translation.

const { buildWorkerToast } = require('../tasking-helpers.js');

describe('buildWorkerToast — empty queue', () => {
  it('processed=0 returns success toast', () => {
    const r = buildWorkerToast({ processed: 0, message: 'queue empty' });
    assert.equal(r.kind, 'success');
    assert.ok(/no pending/i.test(r.msg));
  });

  it('missing processed treated as 0', () => {
    const r = buildWorkerToast({ counts: {} });
    assert.equal(r.kind, 'success');
    assert.ok(/no pending/i.test(r.msg));
  });
});

describe('buildWorkerToast — happy path', () => {
  it('1 task triaged → singular "task"', () => {
    const r = buildWorkerToast({ processed: 1, counts: { triaged: 1 } });
    assert.equal(r.kind, 'success');
    assert.ok(/triaged 1 task/i.test(r.msg));
    assert.ok(!/tasks/.test(r.msg), 'should NOT pluralize "tasks" for one task');
    assert.ok(/1 triaged/.test(r.msg));
  });

  it('5 tasks triaged → plural "tasks"', () => {
    const r = buildWorkerToast({ processed: 5, counts: { triaged: 5 } });
    assert.equal(r.kind, 'success');
    assert.ok(/triaged 5 tasks/i.test(r.msg));
    assert.ok(/5 triaged/.test(r.msg));
  });
});

describe('buildWorkerToast — mixed counts', () => {
  it('triaged + fin_skip surfaces both', () => {
    const r = buildWorkerToast({
      processed: 4,
      counts: { triaged: 3, fin_skip: 1 },
    });
    assert.equal(r.kind, 'success');
    assert.ok(/3 triaged/.test(r.msg));
    assert.ok(/1 Fin-skipped/.test(r.msg));
  });

  it('triage_raced surfaces in detail', () => {
    const r = buildWorkerToast({
      processed: 2,
      counts: { triaged: 1, triage_raced: 1 },
    });
    assert.equal(r.kind, 'success');
    assert.ok(/1 raced/.test(r.msg));
  });
});

describe('buildWorkerToast — failures escalate to warn', () => {
  it('any failed count flips kind to "warn"', () => {
    const r = buildWorkerToast({
      processed: 3,
      counts: { triaged: 2, failed: 1 },
    });
    assert.equal(r.kind, 'warn');
    assert.ok(/2 triaged/.test(r.msg));
    assert.ok(/1 failed/.test(r.msg));
  });

  it('all failures = warn', () => {
    const r = buildWorkerToast({
      processed: 3,
      counts: { failed: 3 },
    });
    assert.equal(r.kind, 'warn');
    assert.ok(/3 failed/.test(r.msg));
  });
});

describe('buildWorkerToast — defensive input handling', () => {
  it('null response → error toast', () => {
    const r = buildWorkerToast(null);
    assert.equal(r.kind, 'error');
    assert.ok(/no response/i.test(r.msg));
  });

  it('undefined response → error toast', () => {
    const r = buildWorkerToast(undefined);
    assert.equal(r.kind, 'error');
  });

  it('non-object response → error toast', () => {
    assert.equal(buildWorkerToast('triaged 5').kind, 'error');
    assert.equal(buildWorkerToast(42).kind, 'error');
    assert.equal(buildWorkerToast([]).kind, 'success'); // [] is an object, processed=0 path
  });

  it('processed present but counts missing → omits detail block', () => {
    const r = buildWorkerToast({ processed: 3 });  // no counts
    assert.ok(/triaged 3 tasks\./i.test(r.msg));
    assert.ok(!/\(/.test(r.msg), 'no parenthesized detail when counts missing');
  });

  it('counts is non-object → treated as empty', () => {
    const r = buildWorkerToast({ processed: 2, counts: 'oops' });
    assert.ok(/triaged 2/i.test(r.msg));
    assert.ok(!/\(/.test(r.msg));
  });
});
