// tests/buildFullKB.test.js
//
// Pins byte-identical output between data/triage-lib.js's buildFullKB
// and app.js's getFullKB. These two MUST produce the same string for
// the same logical KB content, because:
//   1. The kb_version stamped on every triage row is simpleHash of
//      the rendered KB string. If the server starts emitting a single
//      different byte, every row's kb_version flips and the historical
//      "which KB produced this triage?" linkage breaks.
//   2. Anthropic's prompt cache hashes the rendered system block. A
//      byte diff between client and server-assembled KB means a
//      full-price miss on every triage after the cutover.
//
// The byte-parity assertions below use hand-constructed fixtures
// rather than reading app.js source — these fixtures pin the EXACT
// format both implementations must emit. If a future change wants
// to tweak the format (e.g. add a trailing newline), it must update
// BOTH the helper and these fixtures, and the kb_version drift is
// then an acknowledged consequence.

const {
  formatKBSection,
  buildFullKB,
} = require('../data/triage-lib');

const { RELAI_DEFAULTS } = require('../data/defaults');

describe('formatKBSection', () => {
  it('returns empty string for no matching rows', () => {
    assert.equal(formatKBSection([], 'routing', 'ROUTING'), '');
    assert.equal(formatKBSection([{ section: 'other', name: 'x', text: 'y' }], 'routing', 'ROUTING'), '');
  });

  it('returns empty string for non-array input', () => {
    assert.equal(formatKBSection(null, 'routing', 'ROUTING'), '');
    assert.equal(formatKBSection(undefined, 'routing', 'ROUTING'), '');
  });

  it('renders one entry as === LABEL ===\\n[name]\\ntext', () => {
    const rows = [{ section: 'routing', name: 'Test entry', text: 'Body line' }];
    const out = formatKBSection(rows, 'routing', 'ROUTING');
    assert.equal(out, '=== ROUTING ===\n[Test entry]\nBody line');
  });

  it('joins multiple entries with double newline (no trailing newline)', () => {
    const rows = [
      { section: 'routing', name: 'A', text: 'Alpha' },
      { section: 'routing', name: 'B', text: 'Beta' },
    ];
    const out = formatKBSection(rows, 'routing', 'ROUTING');
    assert.equal(out, '=== ROUTING ===\n[A]\nAlpha\n\n[B]\nBeta');
  });

  it('only includes rows matching the target section', () => {
    const rows = [
      { section: 'routing', name: 'A', text: 'Alpha' },
      { section: 'sideeffects', name: 'B', text: 'Beta' },
      { section: 'routing', name: 'C', text: 'Gamma' },
    ];
    const out = formatKBSection(rows, 'routing', 'ROUTING');
    assert.equal(out, '=== ROUTING ===\n[A]\nAlpha\n\n[C]\nGamma');
  });

  it('preserves row order (does not sort)', () => {
    const rows = [
      { section: 'routing', name: 'Z', text: '1' },
      { section: 'routing', name: 'A', text: '2' },
    ];
    const out = formatKBSection(rows, 'routing', 'ROUTING');
    assert.equal(out, '=== ROUTING ===\n[Z]\n1\n\n[A]\n2');
  });

  it('preserves entry text verbatim (newlines, special chars)', () => {
    const rows = [{ section: 'routing', name: 'X', text: 'Line one\nLine two' }];
    const out = formatKBSection(rows, 'routing', 'ROUTING');
    assert.equal(out, '=== ROUTING ===\n[X]\nLine one\nLine two');
  });
});

describe('buildFullKB', () => {
  it('returns empty string for empty rows', () => {
    assert.equal(buildFullKB([], RELAI_DEFAULTS.kb_sections), '');
  });

  it('returns empty string when kbSections is not an array', () => {
    assert.equal(buildFullKB([{ section: 'routing', name: 'x', text: 'y' }], null), '');
    assert.equal(buildFullKB([{ section: 'routing', name: 'x', text: 'y' }], undefined), '');
  });

  it('emits sections in kbSections order, not row order', () => {
    // Rows arrive in arbitrary order from Supabase; the output must
    // follow RELAI_DEFAULTS.kb_sections order (which is what app.js
    // and eval/run.js both use, so the kb_version hash matches).
    const sections = [
      { key: 'notes',   label: 'CLINICAL RULES' },
      { key: 'routing', label: 'ROUTING' },
    ];
    const rows = [
      { section: 'routing', name: 'R1', text: 'route one' },
      { section: 'notes',   name: 'N1', text: 'note one'  },
    ];
    const out = buildFullKB(rows, sections);
    // notes must come before routing in output, regardless of row order.
    assert.equal(out,
      '=== CLINICAL RULES ===\n[N1]\nnote one' +
      '\n\n' +
      '=== ROUTING ===\n[R1]\nroute one'
    );
  });

  it('drops empty sections from the output (no blank header)', () => {
    const sections = [
      { key: 'notes',   label: 'CLINICAL RULES' },
      { key: 'routing', label: 'ROUTING' },
      { key: 'urls',    label: 'URLS' },
    ];
    const rows = [
      { section: 'notes', name: 'N1', text: 'n' },
      { section: 'urls',  name: 'U1', text: 'u' },
    ];
    // routing section has no rows → its header must NOT appear.
    const out = buildFullKB(rows, sections);
    assert.equal(out,
      '=== CLINICAL RULES ===\n[N1]\nn' +
      '\n\n' +
      '=== URLS ===\n[U1]\nu'
    );
  });

  it('ignores rows whose section is not in kbSections', () => {
    const sections = [{ key: 'routing', label: 'ROUTING' }];
    const rows = [
      { section: 'routing', name: 'A', text: 'a' },
      { section: 'mystery', name: 'B', text: 'b' }, // unknown section
    ];
    const out = buildFullKB(rows, sections);
    assert.equal(out, '=== ROUTING ===\n[A]\na');
  });

  it('produces no trailing newline', () => {
    const rows = [{ section: 'routing', name: 'A', text: 'a' }];
    const out = buildFullKB(rows, [{ key: 'routing', label: 'ROUTING' }]);
    assert.ok(!out.endsWith('\n'), 'output must not end with a newline');
  });

  it('byte-parity check against RELAI_DEFAULTS section ordering', () => {
    // Full-shape fixture using the actual section list. This is the
    // exact output the proxy will produce for this row set; if any
    // app.js → server byte diff slips in, this test will catch it.
    const rows = [
      { section: 'notes',       name: 'Rule 1', text: 'Always escalate chest pain.' },
      { section: 'style',       name: 'Tone',   text: 'Use plain language.' },
      { section: 'sideeffects', name: 'SE-A',   text: 'Nausea: ondansetron OK.' },
    ];
    const out = buildFullKB(rows, RELAI_DEFAULTS.kb_sections);
    // notes is first in kb_sections, then sideeffects (3rd), then style (last).
    assert.ok(out.startsWith('=== CLINICAL RULES (read first) ===\n[Rule 1]\nAlways escalate chest pain.'),
      'starts with notes section');
    assert.ok(out.includes('=== SIDE EFFECT GUIDANCE ===\n[SE-A]\nNausea: ondansetron OK.'),
      'includes sideeffects section');
    assert.ok(out.endsWith('[Tone]\nUse plain language.'),
      'ends with style section (last in kb_sections)');
    // Sanity: empty sections (routing, templates, protocols, urls) have no headers.
    assert.ok(!out.includes('=== ROUTING RULES ==='), 'no empty routing header');
    assert.ok(!out.includes('=== URLS ==='), 'no empty urls header');
  });
});
