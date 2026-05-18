// tests/holdWindowAndCoalescing.test.js
//
// Unit tests for the pure helpers behind the 5-minute hold window and
// same-conversation coalescing workflow (migration 0033):
//
//   * buildCoalescingFields (intercom.js)
//       Decides whether a new inbound row is a primary (surface_at set,
//       primary_task_id null) or a follow-on (primary_task_id set,
//       surface_at null) based on whether an open primary already
//       exists for the conversation.
//
//   * clearsSeverityThreshold (worker-background.js)
//       Returns true when a classification patch's urgency_score
//       meets/exceeds the severity threshold. Used by the worker to
//       decide whether to clear surface_at on a primary (bypass the
//       hold) when its own classification is severe.
//
//   * buildPrimaryEscalationPatch (worker-background.js)
//       Computes what (if anything) to PATCH onto a primary task when
//       one of its follow-on rows finishes classification. Highest-
//       severity-wins: never downgrades; only writes fields that
//       strictly improve the primary's queue treatment.

const {
  buildCoalescingFields,
  HOLD_WINDOW_MS,
} = require('../netlify/functions/intercom.js');

const {
  clearsSeverityThreshold,
  buildPrimaryEscalationPatch,
} = require('../netlify/functions/worker-background.js');

// ─────────────────────────────────────────────────────────────────
// buildCoalescingFields
// ─────────────────────────────────────────────────────────────────

describe('buildCoalescingFields — no existing primary (new conversation)', () => {
  const NOW_MS = Date.parse('2026-05-17T12:00:00.000Z');

  it('returns surface_at = now + HOLD_WINDOW_MS and primary_task_id null', () => {
    const out = buildCoalescingFields(null, NOW_MS);
    assert.equal(out.primary_task_id, null);
    assert.equal(out.surface_at, new Date(NOW_MS + HOLD_WINDOW_MS).toISOString());
  });

  it('treats undefined existing-primary id the same as null', () => {
    const out = buildCoalescingFields(undefined, NOW_MS);
    assert.equal(out.primary_task_id, null);
    assert.ok(typeof out.surface_at === 'string');
  });

  it('uses the explicit `now` parameter (no real-clock dependence)', () => {
    const fixedNow = Date.parse('2026-01-01T00:00:00.000Z');
    const out = buildCoalescingFields(null, fixedNow);
    assert.equal(out.surface_at, new Date(fixedNow + HOLD_WINDOW_MS).toISOString());
  });
});

describe('buildCoalescingFields — existing open primary (coalesce)', () => {
  const NOW_MS = Date.parse('2026-05-17T12:00:00.000Z');
  const PRIMARY_ID = '11111111-1111-1111-1111-111111111111';

  it('returns primary_task_id set and surface_at null', () => {
    const out = buildCoalescingFields(PRIMARY_ID, NOW_MS);
    assert.equal(out.primary_task_id, PRIMARY_ID);
    assert.equal(out.surface_at, null);
  });

  it('ignores nowMs when coalescing (no hold needed)', () => {
    const a = buildCoalescingFields(PRIMARY_ID, NOW_MS);
    const b = buildCoalescingFields(PRIMARY_ID, NOW_MS + 86400000);
    assert.deepEqual(a, b);
  });
});

describe('HOLD_WINDOW_MS — sanity', () => {
  it('is 5 minutes in milliseconds', () => {
    assert.equal(HOLD_WINDOW_MS, 5 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────
// clearsSeverityThreshold
// ─────────────────────────────────────────────────────────────────

describe('clearsSeverityThreshold', () => {
  const THRESHOLD = 7;

  it('returns true when urgency_score is above threshold', () => {
    assert.equal(clearsSeverityThreshold({ urgency_score: 8 }, THRESHOLD), true);
  });

  it('returns true when urgency_score is exactly at threshold', () => {
    assert.equal(clearsSeverityThreshold({ urgency_score: 7 }, THRESHOLD), true);
  });

  it('returns false when urgency_score is below threshold', () => {
    assert.equal(clearsSeverityThreshold({ urgency_score: 6 }, THRESHOLD), false);
  });

  it('treats missing urgency_score as 0', () => {
    assert.equal(clearsSeverityThreshold({}, THRESHOLD), false);
  });

  it('treats non-number urgency_score as 0', () => {
    assert.equal(clearsSeverityThreshold({ urgency_score: 'high' }, THRESHOLD), false);
    assert.equal(clearsSeverityThreshold({ urgency_score: null }, THRESHOLD), false);
  });

  it('returns false on null / undefined patch', () => {
    assert.equal(clearsSeverityThreshold(null, THRESHOLD), false);
    assert.equal(clearsSeverityThreshold(undefined, THRESHOLD), false);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildPrimaryEscalationPatch
// ─────────────────────────────────────────────────────────────────

describe('buildPrimaryEscalationPatch — severity climb', () => {
  const THRESHOLD = 7;

  it('propagates urgency_score / urgency_original / clinical_routing_level when new > current', () => {
    const primary = {
      urgency_score: 3,
      urgency_original: 'routine',
      clinical_routing_level: 'mild',
      status: 'triaged',
      surface_at: null,
    };
    const newClassification = {
      urgency_score: 8,
      urgency_original: 'urgent',
      clinical_routing_level: 'severe',
      status: 'reviewed',
    };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch.urgency_score, 8);
    assert.equal(patch.urgency_original, 'urgent');
    assert.equal(patch.clinical_routing_level, 'severe');
  });

  it('does NOT downgrade when new < current (highest wins)', () => {
    const primary = {
      urgency_score: 8,
      urgency_original: 'urgent',
      clinical_routing_level: 'severe',
      status: 'reviewed',
      surface_at: null,
    };
    const newClassification = {
      urgency_score: 2,
      urgency_original: 'routine',
      clinical_routing_level: 'mild',
      status: 'triaged',
    };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch, null);
  });

  it('does NOT write urgency fields when new === current (tie, no climb)', () => {
    const primary = {
      urgency_score: 5,
      urgency_original: 'same-day',
      clinical_routing_level: 'moderate',
      status: 'triaged',
      surface_at: null,
    };
    const newClassification = {
      urgency_score: 5,
      urgency_original: 'same-day',
      clinical_routing_level: 'moderate',
      status: 'triaged',
    };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch, null);
  });
});

describe('buildPrimaryEscalationPatch — status escalation', () => {
  const THRESHOLD = 7;

  it('escalates triaged → reviewed when new row is reviewed', () => {
    const primary = { urgency_score: 5, status: 'triaged', surface_at: null };
    const newClassification = { urgency_score: 5, status: 'reviewed' };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch.status, 'reviewed');
  });

  it('does NOT downgrade reviewed → triaged', () => {
    const primary = { urgency_score: 5, status: 'reviewed', surface_at: null };
    const newClassification = { urgency_score: 5, status: 'triaged' };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch, null);
  });

  it('combines status escalation with severity climb in one patch', () => {
    const primary = {
      urgency_score: 3,
      urgency_original: 'routine',
      clinical_routing_level: 'mild',
      status: 'triaged',
      surface_at: null,
    };
    const newClassification = {
      urgency_score: 9,
      urgency_original: 'urgent',
      clinical_routing_level: 'severe',
      status: 'reviewed',
    };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch.urgency_score, 9);
    assert.equal(patch.status, 'reviewed');
    assert.equal(patch.clinical_routing_level, 'severe');
  });
});

describe('buildPrimaryEscalationPatch — surface_at bypass', () => {
  const THRESHOLD = 7;

  it('clears surface_at when new row crosses threshold AND primary still held', () => {
    const heldUntil = new Date(Date.now() + 60000).toISOString();
    const primary = { urgency_score: 3, status: 'triaged', surface_at: heldUntil };
    const newClassification = { urgency_score: 8, status: 'reviewed' };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.ok(patch);
    assert.equal(patch.surface_at, null);
  });

  it('does NOT touch surface_at when new row is below threshold', () => {
    const heldUntil = new Date(Date.now() + 60000).toISOString();
    const primary = { urgency_score: 3, status: 'triaged', surface_at: heldUntil };
    const newClassification = { urgency_score: 6, status: 'triaged' };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    // 6 > 3 so urgency climbs, but 6 < 7 so no bypass.
    assert.equal(patch.urgency_score, 6);
    assert.ok(!('surface_at' in patch));
  });

  it('does NOT touch surface_at when primary already surfaced (surface_at null)', () => {
    const primary = { urgency_score: 3, status: 'triaged', surface_at: null };
    const newClassification = { urgency_score: 9, status: 'reviewed' };
    const patch = buildPrimaryEscalationPatch(primary, newClassification, THRESHOLD);
    assert.equal(patch.urgency_score, 9);
    assert.ok(!('surface_at' in patch));
  });
});

describe('buildPrimaryEscalationPatch — null safety', () => {
  it('returns null when currentPrimary is null', () => {
    assert.equal(buildPrimaryEscalationPatch(null, { urgency_score: 9 }, 7), null);
  });

  it('returns null when newClassification is null', () => {
    assert.equal(buildPrimaryEscalationPatch({ urgency_score: 3, status: 'triaged' }, null, 7), null);
  });

  it('treats missing urgency_score as 0 on both sides', () => {
    const patch = buildPrimaryEscalationPatch({ status: 'triaged' }, { status: 'triaged' }, 7);
    assert.equal(patch, null);
  });
});
