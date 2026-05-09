// Minimal Node test runner — no framework dependency. Discover *.test.js
// files in this directory, run each, count passes/fails, exit non-zero
// on any failure.

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

let totalPass = 0;
let totalFail = 0;
const failures = [];

global.describe = function(name, fn) {
  console.log('\n  ' + name);
  fn();
};

global.it = function(name, fn) {
  try {
    fn();
    totalPass++;
    console.log('    ✓ ' + name);
  } catch (err) {
    totalFail++;
    failures.push({ name, err });
    console.log('    ✗ ' + name);
    console.log('        ' + err.message);
  }
};

global.assert = require('assert').strict;

console.log('Running ' + files.length + ' test file(s):');
for (const f of files) {
  require(path.join(__dirname, f));
}

console.log('\n' + (totalFail === 0 ? '✓' : '✗') + ' ' + totalPass + ' passed, ' + totalFail + ' failed');
process.exit(totalFail === 0 ? 0 : 1);
