// tests/runTriageRequestShape.test.js
//
// CONTRACT TEST — pins the exact shape of the request body app.js's
// runTriage() sends to /.netlify/functions/triage today. The triage
// proxy is already e2e-tested (triageProxy.test.js) under the
// assumption that the client sends a multi-block cached `system`
// array; this test pins the client side of that assumption so the
// two contracts cannot drift silently.
//
// What this guards against:
//   - Someone refactoring runTriage to send `system: someString`
//     instead of the multi-block array (would silently disable
//     Anthropic prompt caching and explode cost).
//   - Someone removing the cache_control:ephemeral annotation from
//     BASE_PROMPT or KB blocks (same cost-blast issue).
//   - The pre-multi-tenant work in triage.js:9-20 (moving system
//     assembly server-side). When that lands, THIS test will fail
//     loudly with "BASE_PROMPT no longer appears in app.js runTriage"
//     — which is the expected, deliberate change. Update the test
//     to assert the new contract at that point.
//
// We can't require app.js in Node (it's a browser script that
// references DOM globals at top level), so we read source text and
// pattern-match on anchor strings — same approach as
// triagePathContract.test.js. Tests are intentionally tolerant of
// formatting changes (regex with .* on whitespace) but intolerant
// of identifier renames and contract changes.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('CONTRACT: runTriage request shape (app.js → /.netlify/functions/triage)', () => {

  it('constructs a systemBlocks array (not a single string)', () => {
    // Anchor on the literal array opening that includes BASE_PROMPT
    // on the next line — this is the exact construction at app.js:1181.
    // If someone changes `system: systemBlocks` to `system: somePrompt`,
    // this anchor fails first with a clearer message than the downstream
    // assertions.
    assert.ok(
      /var\s+systemBlocks\s*=\s*\[/.test(appSrc),
      'runTriage no longer declares `var systemBlocks = [...]` — has the system assembly been refactored?'
    );
  });

  it('first system block uses BASE_PROMPT with ephemeral cache_control', () => {
    // Match the full first-block literal. Order of properties matters
    // for cache prefix stability — Anthropic's prompt cache hashes the
    // first N tokens of system, so reordering BASE_PROMPT vs KB breaks
    // the cache hit rate.
    assert.ok(
      /\{\s*type\s*:\s*['"]text['"]\s*,\s*text\s*:\s*BASE_PROMPT\s*,\s*cache_control\s*:\s*\{\s*type\s*:\s*['"]ephemeral['"]\s*\}\s*\}/.test(appSrc),
      'first system block no longer matches { type:"text", text: BASE_PROMPT, cache_control:{type:"ephemeral"} }'
    );
  });

  it('second system block uses getFullKB() with ephemeral cache_control', () => {
    assert.ok(
      /\{\s*type\s*:\s*['"]text['"]\s*,\s*text\s*:\s*getFullKB\(\)\s*,\s*cache_control\s*:\s*\{\s*type\s*:\s*['"]ephemeral['"]\s*\}\s*\}/.test(appSrc),
      'second system block no longer matches { type:"text", text: getFullKB(), cache_control:{type:"ephemeral"} }'
    );
  });

  it('appends a staff-examples block conditionally, without cache_control', () => {
    // The third block is intentionally uncached because it changes as
    // corrections accumulate (see app.js:1185-1187 comment). Caching
    // it would poison the prefix for every subsequent triage.
    assert.ok(
      /if\s*\(\s*examplesBlock\s*\)\s*\{\s*systemBlocks\.push\(\s*\{\s*type\s*:\s*['"]text['"]\s*,\s*text\s*:\s*examplesBlock\s*\}\s*\)\s*;?\s*\}/.test(appSrc),
      'examplesBlock conditional push no longer matches expected shape — see app.js:1188'
    );
    // Negative assertion: the examplesBlock push must NOT include
    // cache_control. If someone "fixes" the inconsistency by adding
    // cache_control, every triage poisons the prompt cache.
    assert.ok(
      !/systemBlocks\.push\(\s*\{\s*type\s*:\s*['"]text['"]\s*,\s*text\s*:\s*examplesBlock\s*,\s*cache_control/.test(appSrc),
      'examplesBlock push has acquired a cache_control annotation — this poisons the Anthropic prompt cache'
    );
  });

  it('POSTs to /.netlify/functions/triage with system: systemBlocks and a single user message', () => {
    // Anchor on the fetch URL string AND the body.system field. These
    // sit on the same JSON.stringify line in app.js:1200 today; allowing
    // for line breaks in the regex is intentional in case the file is
    // reformatted.
    assert.ok(
      /authFetch\(\s*['"]\/\.netlify\/functions\/triage['"]/.test(appSrc),
      'runTriage no longer calls authFetch("/.netlify/functions/triage", ...)'
    );
    assert.ok(
      /system\s*:\s*systemBlocks\s*,\s*messages\s*:\s*\[\s*\{\s*role\s*:\s*['"]user['"]\s*,\s*content\s*:/.test(appSrc),
      'runTriage no longer sends `system: systemBlocks, messages: [{role:"user", content: ...}]` — has the request body shape changed?'
    );
  });

  it('uses claude-sonnet-4-6 as the triage model (default)', () => {
    // The model allowlist in triage.js:49-53 permits sonnet, haiku,
    // and opus. Production triage should use sonnet by default — a
    // silent change to haiku would degrade clinical reasoning quality;
    // a silent change to opus would 3-5x the per-triage cost.
    assert.ok(
      /model\s*:\s*['"]claude-sonnet-4-6['"]/.test(appSrc),
      'runTriage no longer defaults to claude-sonnet-4-6 — verify this is an intentional model change'
    );
  });
});
