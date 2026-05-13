// Minimal Node test runner — no framework dependency. Discover *.test.js
// files in this directory, run each, count passes/fails, exit non-zero
// on any failure.
//
// Async-aware: an `it(name, async fn)` whose returned promise rejects
// counts as a failure. Tests are deferred (registered, not invoked at
// require time) and then drained one at a time, so a test that
// installs a global stub (e.g. patches global.fetch) doesn't race
// with the next test's setup. Without serialization, tests that
// share global state could see each other's stubs and either pass
// for the wrong reason or fail intermittently.

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

let totalPass = 0;
let totalFail = 0;
const failures = [];

// Queue of test registrations. Filled during require-time when test
// files call describe/it; drained sequentially by main().
const queue = [];

global.describe = function(name, fn) {
  queue.push({ kind: 'describe', name });
  fn();
};

global.it = function(name, fn) {
  // Defer invocation — store the fn, run it during the drain loop
  // so tests execute strictly one at a time.
  queue.push({ kind: 'test', name, fn });
};

global.assert = require('assert').strict;

async function main() {
  console.log('Running ' + files.length + ' test file(s):');
  for (const f of files) {
    require(path.join(__dirname, f));
  }
  for (const item of queue) {
    if (item.kind === 'describe') {
      console.log('\n  ' + item.name);
      continue;
    }
    try {
      const result = item.fn();
      if (result && typeof result.then === 'function') {
        await result;
      }
      totalPass++;
      console.log('    ✓ ' + item.name);
    } catch (err) {
      totalFail++;
      failures.push({ name: item.name, err });
      console.log('    ✗ ' + item.name);
      console.log('        ' + (err && err.message ? err.message : String(err)));
    }
  }
  console.log('\n' + (totalFail === 0 ? '✓' : '✗') + ' ' + totalPass + ' passed, ' + totalFail + ' failed');
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('runner.fatal:', err && err.stack || err);
  process.exit(2);
});
