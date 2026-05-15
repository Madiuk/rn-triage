// tests/runTriageRequestShape.test.js
//
// CONTRACT TEST — pins the post-#2 shape of the request body app.js's
// runTriage() sends to /.netlify/functions/triage. After Commit C of
// the contract lockdown:
//   - The client MUST NOT include `system` in the POST body. The
//     proxy assembles BASE_PROMPT + tenant KB + recent staff examples
//     server-side from supabase. Sending body.system gets a 400.
//   - The body MUST be exactly one user message:
//     messages: [{ role: 'user', content: ... }]
//   - The model defaults to claude-sonnet-4-6.
//
// What this guards against:
//   - A regression that adds `system: ...` back into the POST body
//     would 400 every triage in production. This test catches it
//     before deploy.
//   - A regression that sends multi-turn messages or a non-user role
//     would 400 every triage in production. Same guard.
//   - A silent model swap (sonnet → opus 3-5x cost, sonnet → haiku
//     quality drop).
//
// We can't require app.js in Node (it's a browser script that
// references DOM globals at top level), so we read source text and
// pattern-match on anchor strings — same approach as
// triagePathContract.test.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('CONTRACT: runTriage request shape (app.js → /.netlify/functions/triage)', () => {

  it('POSTs to /.netlify/functions/triage', () => {
    assert.ok(
      /authFetch\(\s*['"]\/\.netlify\/functions\/triage['"]/.test(appSrc),
      'runTriage no longer calls authFetch("/.netlify/functions/triage", ...)'
    );
  });

  it('sends a single user-role message and NO system field', () => {
    // Anchor on the JSON.stringify body for the triage POST. Anchor
    // must include model + max_tokens + messages so we're looking at
    // the triage call, not some other endpoint. The negative-match
    // on `system:` is the heart of the lockdown — if a future change
    // adds it back, every triage 400s on the proxy's strict gate.
    const m = appSrc.match(
      /authFetch\(\s*['"]\/\.netlify\/functions\/triage['"][\s\S]*?body\s*:\s*JSON\.stringify\(\s*(\{[\s\S]*?\})\s*\)/
    );
    assert.ok(m, 'could not locate runTriage POST body literal');
    const bodyLiteral = m[1];

    // Single user message with content reference.
    assert.ok(
      /messages\s*:\s*\[\s*\{\s*role\s*:\s*['"]user['"]\s*,\s*content\s*:/.test(bodyLiteral),
      'POST body messages no longer matches [{role:"user", content: ...}] — has the message shape changed?'
    );

    // Hard negative: no `system:` field in the POST body. Whitespace-
    // tolerant. If a future edit re-introduces it (perhaps to "fix"
    // a perceived caching issue), this fires.
    assert.ok(
      !/\bsystem\s*:/.test(bodyLiteral),
      'POST body contains `system:` — the proxy rejects body.system. ' +
      'BASE_PROMPT/KB/examples are assembled server-side.'
    );

    // Negative: no second message. Triage is one-shot.
    const userMatches = bodyLiteral.match(/role\s*:\s*['"]user['"]/g) || [];
    const assistantMatches = bodyLiteral.match(/role\s*:\s*['"]assistant['"]/g) || [];
    assert.equal(userMatches.length, 1, 'must be exactly one user message');
    assert.equal(assistantMatches.length, 0, 'must NOT include an assistant turn');
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

  it('does NOT call loadStaffExamples or getStaffExamplesBlock', () => {
    // These helpers were retired in Commit C of #2; the proxy now
    // fetches history and assembles the examples block server-side.
    // A re-introduction in app.js would mean the browser is doing
    // duplicate work AND the assumption that no /history call fires
    // at triage time is broken (latency regression + cache pressure).
    assert.ok(
      !/\bloadStaffExamples\s*\(/.test(appSrc),
      'app.js calls loadStaffExamples — that helper was retired in #2 (server now assembles examples)'
    );
    assert.ok(
      !/\bgetStaffExamplesBlock\s*\(/.test(appSrc),
      'app.js calls getStaffExamplesBlock — that helper was retired in #2'
    );
  });
});
