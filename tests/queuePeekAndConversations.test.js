// tests/queuePeekAndConversations.test.js
//
// Unit tests for the pure helpers behind the two read-only audit
// endpoints added alongside the Event Log "Conversations" subtab:
//
//   * canViewTask(profile, task) — gates GET /queue/peek. Super-users
//     can always read (audit access); other staff can read only the
//     tasks they own. Defines the rule once so changes don't drift
//     between the HTTP layer and the SPA's mirror of the same logic.
//
//   * clampConversationsLimit(rawLimit) — gates GET
//     /queue/conversations/recent. Returns DEFAULT for missing /
//     negative / non-numeric input, MAX for over-limit input, and
//     the value itself otherwise.

const {
  canViewTask,
  clampConversationsLimit,
  CONVERSATIONS_RECENT_DEFAULT_LIMIT,
  CONVERSATIONS_RECENT_MAX_LIMIT,
} = require('../netlify/functions/_lib/routes/queue.js');

// ─────────────────────────────────────────────────────────────────
// canViewTask
// ─────────────────────────────────────────────────────────────────

describe('canViewTask — super-user', () => {
  const su = { id: 'su-1', is_super_user: true };

  it('returns true for a task owned by someone else', () => {
    assert.equal(canViewTask(su, { claimed_by: 'someone-else' }), true);
  });

  it('returns true for an unclaimed task', () => {
    assert.equal(canViewTask(su, { claimed_by: null }), true);
  });

  it('returns true for a task they happen to own', () => {
    assert.equal(canViewTask(su, { claimed_by: 'su-1' }), true);
  });
});

describe('canViewTask — non-super-user', () => {
  const staff = { id: 'staff-1', is_super_user: false };

  it('returns true when the task is owned by the caller', () => {
    assert.equal(canViewTask(staff, { claimed_by: 'staff-1' }), true);
  });

  it('returns false when the task is owned by someone else', () => {
    assert.equal(canViewTask(staff, { claimed_by: 'staff-2' }), false);
  });

  it('returns false when the task is unclaimed', () => {
    assert.equal(canViewTask(staff, { claimed_by: null }), false);
    assert.equal(canViewTask(staff, { claimed_by: undefined }), false);
    assert.equal(canViewTask(staff, {}), false);
  });

  it('treats missing is_super_user as not-super', () => {
    // Defensive: a profile without an is_super_user field shouldn't
    // accidentally be granted audit access.
    assert.equal(canViewTask({ id: 'staff-1' }, { claimed_by: 'someone-else' }), false);
  });
});

describe('canViewTask — null safety', () => {
  it('returns false when profile is null', () => {
    assert.equal(canViewTask(null, { claimed_by: 'x' }), false);
  });

  it('returns false when task is null', () => {
    assert.equal(canViewTask({ id: 'x', is_super_user: true }, null), false);
  });

  it('returns false when both are null', () => {
    assert.equal(canViewTask(null, null), false);
  });
});

// ─────────────────────────────────────────────────────────────────
// clampConversationsLimit
// ─────────────────────────────────────────────────────────────────

describe('clampConversationsLimit', () => {
  it('returns the input when within range', () => {
    assert.equal(clampConversationsLimit(5), 5);
    assert.equal(clampConversationsLimit('5'), 5);
    assert.equal(clampConversationsLimit(1), 1);
    assert.equal(clampConversationsLimit(CONVERSATIONS_RECENT_MAX_LIMIT),
      CONVERSATIONS_RECENT_MAX_LIMIT);
  });

  it('clamps over-MAX values down to MAX', () => {
    assert.equal(clampConversationsLimit(CONVERSATIONS_RECENT_MAX_LIMIT + 1),
      CONVERSATIONS_RECENT_MAX_LIMIT);
    assert.equal(clampConversationsLimit(1e9), CONVERSATIONS_RECENT_MAX_LIMIT);
  });

  it('defaults on zero / negative input', () => {
    assert.equal(clampConversationsLimit(0), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
    assert.equal(clampConversationsLimit(-1), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
  });

  it('defaults on missing / non-numeric input', () => {
    assert.equal(clampConversationsLimit(undefined), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
    assert.equal(clampConversationsLimit(null), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
    assert.equal(clampConversationsLimit(''), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
    assert.equal(clampConversationsLimit('abc'), CONVERSATIONS_RECENT_DEFAULT_LIMIT);
  });

  it('parses numeric strings (typical query param case)', () => {
    assert.equal(clampConversationsLimit('25'), 25);
    assert.equal(clampConversationsLimit('100'), CONVERSATIONS_RECENT_MAX_LIMIT);
  });
});
