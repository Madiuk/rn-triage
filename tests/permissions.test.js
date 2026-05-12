// tests/permissions.test.js
//
// Unit tests for netlify/functions/_lib/permissions.js — the
// single source of truth for role / row / action gates on the
// server. These predicates ARE the safety boundary that keeps
// non-clinical staff from sending clinical advice and CSR
// edits from polluting the clinical KB. If anything in this
// file ever fails, the gates aren't doing what we think they
// are.
//
// Added in v0.4.0 (phase 1c) as the first server-side test
// coverage in the codebase. Before this, gate behavior was
// only verified by running the app end-to-end.

const {
  isClinical,
  isNonClinical,
  isAdmin,
  isSuperUser,
  rowIsClinical,
  canMutateRow,
  canResolveReview,
  canEditClinicalCategory,
  canDeleteRow,
  canVoteOnDraft,
  canSaveActualResponse,
  canMarkEscalated,
} = require('../netlify/functions/_lib/permissions.js');

// ─────────────────────────────────────────────────────────────────
// Role classifiers
// ─────────────────────────────────────────────────────────────────

describe('isClinical', () => {
  it('returns true only for role === "Clinical"', () => {
    assert.equal(isClinical({ role: 'Clinical' }), true);
    assert.equal(isClinical({ role: 'Non-Clinical' }), false);
    assert.equal(isClinical({ role: 'staff' }), false);
    assert.equal(isClinical({ role: '' }), false);
    assert.equal(isClinical({}), false);
    assert.equal(isClinical(null), false);
    assert.equal(isClinical(undefined), false);
  });

  it('is case-sensitive (matches production string exactly)', () => {
    // Production data stores 'Clinical' with the capital C.
    // Lowercase, mixed case, or with whitespace must NOT count.
    // If this assertion fails we accidentally widened the gate.
    assert.equal(isClinical({ role: 'clinical' }), false);
    assert.equal(isClinical({ role: 'CLINICAL' }), false);
    assert.equal(isClinical({ role: 'Clinical ' }), false);
    assert.equal(isClinical({ role: ' Clinical' }), false);
  });
});

describe('isNonClinical', () => {
  it('returns true only for role === "Non-Clinical"', () => {
    assert.equal(isNonClinical({ role: 'Non-Clinical' }), true);
    assert.equal(isNonClinical({ role: 'Clinical' }), false);
    assert.equal(isNonClinical({ role: 'staff' }), false);
    assert.equal(isNonClinical({}), false);
    assert.equal(isNonClinical(null), false);
  });

  it('legacy "staff" role is NEITHER clinical nor non-clinical', () => {
    // Defensive: a 'staff' user gets restricted view (not isClinical)
    // but isn't treated as non-clinical either — the consumer should
    // fall through to under-gate behavior.
    const staff = { role: 'staff' };
    assert.equal(isClinical(staff), false);
    assert.equal(isNonClinical(staff), false);
  });
});

describe('isAdmin', () => {
  it('returns true only when is_admin is exactly true', () => {
    assert.equal(isAdmin({ is_admin: true }), true);
    assert.equal(isAdmin({ is_admin: false }), false);
    assert.equal(isAdmin({}), false);
    // Truthy values that AREN'T literally true should NOT pass.
    // A migration bug that wrote 'true' (string) instead of true
    // shouldn't accidentally grant admin.
    assert.equal(isAdmin({ is_admin: 'true' }), false);
    assert.equal(isAdmin({ is_admin: 1 }), false);
    assert.equal(isAdmin(null), false);
  });
});

describe('isSuperUser', () => {
  it('returns true only when is_super_user is exactly true', () => {
    assert.equal(isSuperUser({ is_super_user: true }), true);
    assert.equal(isSuperUser({ is_super_user: false }), false);
    assert.equal(isSuperUser({}), false);
    assert.equal(isSuperUser({ is_super_user: 'true' }), false);
    assert.equal(isSuperUser(null), false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Row classification — the source of truth for "is clinical"
// ─────────────────────────────────────────────────────────────────

describe('rowIsClinical', () => {
  it('mild/moderate/severe side effect → clinical, regardless of category', () => {
    assert.equal(rowIsClinical({ clinical_routing_level: 'mild' }), true);
    assert.equal(rowIsClinical({ clinical_routing_level: 'moderate' }), true);
    assert.equal(rowIsClinical({ clinical_routing_level: 'severe' }), true);
    // Case-insensitive on the level — AI can emit uppercase.
    assert.equal(rowIsClinical({ clinical_routing_level: 'SEVERE' }), true);
    assert.equal(rowIsClinical({ clinical_routing_level: 'Moderate' }), true);
  });

  it('none/null/missing routing level + clinical category → clinical', () => {
    assert.equal(rowIsClinical({
      clinical_routing_level: 'none',
      clinical_category: 'Injection/Dosing'
    }), true);
    assert.equal(rowIsClinical({
      clinical_category: 'Side Effects'
    }), true);
  });

  it('General Inquiry is NOT clinical (per Big Easy seed)', () => {
    // Practice configuration: General Inquiry is is_clinical=false
    // in category_metadata. Any role can pull tasks tagged General.
    assert.equal(rowIsClinical({
      clinical_routing_level: 'none',
      clinical_category: 'General Inquiry'
    }), false);
    // Legacy 'General/multiple' value (pre-v0.3.6) — same treatment.
    assert.equal(rowIsClinical({
      clinical_category: 'General/multiple'
    }), false);
  });

  it('no clinical content at all → not clinical', () => {
    assert.equal(rowIsClinical({
      clinical_routing_level: 'none',
      clinical_category: null,
      non_clinical_flag: true,
      non_clinical_items: ['Shipment/Tracking']
    }), false);
    assert.equal(rowIsClinical({}), false);
    assert.equal(rowIsClinical(null), false);
    assert.equal(rowIsClinical(undefined), false);
  });

  it('clinical_category trimmed whitespace does not pass as set', () => {
    // Defensive: a category that's just whitespace shouldn't
    // accidentally mark a row as clinical.
    assert.equal(rowIsClinical({
      clinical_routing_level: 'none',
      clinical_category: '   '
    }), false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Composite predicates — what gated endpoints actually call
// ─────────────────────────────────────────────────────────────────

describe('canMutateRow', () => {
  const clinicalRow = { clinical_routing_level: 'mild' };
  const nonClinRow = { clinical_routing_level: 'none', clinical_category: null };
  const generalRow = { clinical_routing_level: 'none', clinical_category: 'General Inquiry' };

  it('clinical can mutate anything', () => {
    const c = { role: 'Clinical' };
    assert.equal(canMutateRow(c, clinicalRow), true);
    assert.equal(canMutateRow(c, nonClinRow), true);
    assert.equal(canMutateRow(c, generalRow), true);
  });

  it('non-clinical cannot mutate clinical rows', () => {
    const nc = { role: 'Non-Clinical' };
    assert.equal(canMutateRow(nc, clinicalRow), false);
  });

  it('non-clinical can mutate non-clinical and general rows', () => {
    const nc = { role: 'Non-Clinical' };
    assert.equal(canMutateRow(nc, nonClinRow), true);
    assert.equal(canMutateRow(nc, generalRow), true);
  });

  it('legacy staff role is treated as non-clinical (under-gate)', () => {
    const staff = { role: 'staff' };
    assert.equal(canMutateRow(staff, clinicalRow), false);
    assert.equal(canMutateRow(staff, nonClinRow), true);
  });

  it('null profile → treated as non-clinical', () => {
    assert.equal(canMutateRow(null, clinicalRow), false);
    assert.equal(canMutateRow(null, nonClinRow), true);
  });
});

describe('canResolveReview', () => {
  it('clinical can resolve any review', () => {
    const c = { role: 'Clinical' };
    assert.equal(canResolveReview(c, { clinical_routing_level: 'severe' }), true);
    assert.equal(canResolveReview(c, { clinical_category: 'General Inquiry' }), true);
    assert.equal(canResolveReview(c, null), true);
  });

  it('non-clinical cannot resolve reviews originating from clinical triages', () => {
    const nc = { role: 'Non-Clinical' };
    assert.equal(canResolveReview(nc, { clinical_routing_level: 'mild' }), false);
    assert.equal(canResolveReview(nc, { clinical_category: 'Injection/Dosing' }), false);
  });

  it('non-clinical can resolve reviews originating from non-clinical triages', () => {
    const nc = { role: 'Non-Clinical' };
    assert.equal(canResolveReview(nc, { clinical_routing_level: 'none', clinical_category: null }), true);
    assert.equal(canResolveReview(nc, { clinical_category: 'General Inquiry' }), true);
  });

  it('missing origin triage → non-clinical may resolve (degraded data is not a gate)', () => {
    // If we can't fetch the origin row (network blip, deleted),
    // we default to permissive on the review side. Caller can
    // tighten this later if it becomes a real failure mode.
    const nc = { role: 'Non-Clinical' };
    assert.equal(canResolveReview(nc, null), true);
    assert.equal(canResolveReview(nc, undefined), true);
  });
});

describe('canEditClinicalCategory', () => {
  it('clinical can edit, non-clinical cannot', () => {
    assert.equal(canEditClinicalCategory({ role: 'Clinical' }), true);
    assert.equal(canEditClinicalCategory({ role: 'Non-Clinical' }), false);
    assert.equal(canEditClinicalCategory({ role: 'staff' }), false);
    assert.equal(canEditClinicalCategory(null), false);
  });
});

describe('aliases of canMutateRow (canDeleteRow, canVoteOnDraft, canSaveActualResponse)', () => {
  // These are the same rule expressed at different call sites for
  // readability. Verify they behave identically — any future
  // divergence is a bug.
  const c = { role: 'Clinical' };
  const nc = { role: 'Non-Clinical' };
  const clinRow = { clinical_routing_level: 'severe' };
  const ncRow = { clinical_routing_level: 'none', clinical_category: null };

  it('all aliases agree with canMutateRow', () => {
    [canDeleteRow, canVoteOnDraft, canSaveActualResponse].forEach(fn => {
      assert.equal(fn(c, clinRow), canMutateRow(c, clinRow));
      assert.equal(fn(c, ncRow), canMutateRow(c, ncRow));
      assert.equal(fn(nc, clinRow), canMutateRow(nc, clinRow));
      assert.equal(fn(nc, ncRow), canMutateRow(nc, ncRow));
    });
  });
});

describe('canMarkEscalated', () => {
  it('any authenticated caller may mark a row escalated', () => {
    // Escalation is non-clinical's only outlet on clinical
    // content. Clinical can also escalate (to flag for a
    // colleague's attention). No restriction beyond auth.
    assert.equal(canMarkEscalated({ role: 'Clinical' }), true);
    assert.equal(canMarkEscalated({ role: 'Non-Clinical' }), true);
    assert.equal(canMarkEscalated({ role: 'staff' }), true);
    assert.equal(canMarkEscalated(null), true);
  });
});
