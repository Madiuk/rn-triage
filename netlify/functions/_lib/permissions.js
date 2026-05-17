// _lib/permissions.js
//
// Pure permission and classification helpers. NO IO. NO DB CALLS.
// Every function in this module takes plain data in and returns
// a boolean/value out. That's what makes them safe to import from
// both Node (server) and the browser (client) — and what makes
// them trivially testable.
//
// Extracted from kb.js (v0.4.0). Centralizing here is the keystone
// of the v0.4 cleanup: every gate in the codebase consults the
// same predicate. Bugs caused by client and server having drifted
// implementations of "is this clinical?" or "can this user resolve
// this review?" become impossible by construction.
//
// Role values match what production stores in profiles.role:
//   'Clinical' | 'Non-Clinical' | (legacy null/empty/'staff')
//
// Under-gate principle: anything NOT explicitly 'Clinical' is
// treated as non-clinical for safety. A user with a legacy or
// missing role gets the restricted experience until an admin
// assigns them a real role.

// ─────────────────────────────────────────────────────────────────
// Role classifiers (profile-level)
// ─────────────────────────────────────────────────────────────────

function isClinical(profile) {
  return !!(profile && profile.role === "Clinical");
}

function isNonClinical(profile) {
  return !!(profile && profile.role === "Non-Clinical");
}

function isAdmin(profile) {
  return !!(profile && profile.is_admin === true);
}

function isSuperUser(profile) {
  return !!(profile && profile.is_super_user === true);
}

// ─────────────────────────────────────────────────────────────────
// Row classification (data-level)
// ─────────────────────────────────────────────────────────────────

// Decide whether a query_history row contains clinical content.
// Used by the role gates to know whether a non-clinical caller is
// trying to act on a row they shouldn't.
//
// Same logic on server (this file) AND client (data/triage-lib.js
// exports resultIsClinical as the client mirror). If either side
// changes, the other must too — the contract test in tests/
// catches drift.
//
// Rules:
//   - Any side-effect detection (clinical_routing_level !== 'none')
//     → clinical, full stop. Severity is a clinical judgment.
//   - A clinical_category set, EXCEPT 'General Inquiry' (which is
//     is_clinical=false in category_metadata per Big Easy's config)
//     and the legacy 'General/multiple' value → clinical.
//   - Otherwise → not clinical.
//
// If a tenant flips 'General Inquiry' to is_clinical=true in their
// category_metadata, this check would still treat General as
// non-clinical here. That's a deliberate floor: General is the
// "any role can pull this" bucket. If a tenant needs General to
// be clinical-gated, they should add an additional clinical-only
// category and stop using General.
function rowIsClinical(row) {
  if (!row) return false;
  const lvl = String(row.clinical_routing_level || "none").toLowerCase();
  if (lvl !== "none") return true;
  const cat = String(row.clinical_category || "").trim();
  if (cat && cat !== "General Inquiry" && cat !== "General/multiple") return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Composite permission predicates
// ─────────────────────────────────────────────────────────────────
//
// These are the questions every gated endpoint actually asks. By
// going through these helpers (instead of inlining the role +
// row checks at each call site), we get one place to update if
// the rules change — and tests can exercise the rules directly
// without spinning up a full Netlify function.

// Can this caller mutate this clinical-or-not row? True for
// clinical staff always. False for non-clinical on clinical rows.
// True for non-clinical on non-clinical rows.
function canMutateRow(profile, row) {
  if (isClinical(profile)) return true;
  return !rowIsClinical(row);
}

// Can this caller resolve this review_request? True if clinical,
// or if non-clinical AND the originating triage is non-clinical.
// The caller is responsible for fetching the originTriage from
// the review's triage_id; this helper is pure.
function canResolveReview(profile, originTriage) {
  if (isClinical(profile)) return true;
  if (!originTriage) return true;  // no origin row = treat as non-clinical
  return !rowIsClinical(originTriage);
}

// Can this caller change clinical_category on a row? Clinical
// only. Non-clinical can edit non_clinical_items freely but
// cannot touch clinical categories (that's a clinical judgment).
function canEditClinicalCategory(profile) {
  return isClinical(profile);
}

// Can this caller delete this row? Same rule as canMutateRow,
// kept as a separate predicate so the semantic intent is explicit
// at call sites.
function canDeleteRow(profile, row) {
  return canMutateRow(profile, row);
}

// Can this caller vote (up/down) on the draft? Same rule —
// voting on a clinical draft is a clinical judgment about the
// AI's medical content.
function canVoteOnDraft(profile, row) {
  return canMutateRow(profile, row);
}

// Can this caller save actual_response_sent? Same rule —
// actual_response_sent on a clinical row is the input the Haiku
// correction analyzer reads. Non-clinical saves here would
// pollute the learning loop.
function canSaveActualResponse(profile, row) {
  return canMutateRow(profile, row);
}

// Any role can mark a row as escalated. Non-clinical's main
// outlet; clinical might use it too (flagging a row for a
// colleague's attention). No restriction beyond authentication.
function canMarkEscalated(/* profile */) {
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Queue / pull eligibility (Phase 3)
// ─────────────────────────────────────────────────────────────────
//
// Advanced-practice-provider tier. Identified by profile.title (MD,
// NP, etc. — caller passes the list from defaults so this stays
// pure and per-tenant configurable). APP attention is reserved for
// clinical work; APP staff are excluded from the Routing Hub and
// from non-clinical categories generally.
function isAppTier(profile, appTitles) {
  if (!profile || !profile.title) return false;
  if (!Array.isArray(appTitles) || appTitles.length === 0) return false;
  return appTitles.indexOf(profile.title) !== -1;
}

// Pull-eligibility for a given category, in tri-state form:
//
//   'always'    — the staffer can pull this category on any pull
//   'idle_only' — eligible only when the staffer's "always" pool is
//                 empty at pull time (the idle-unlock rule from
//                 PLAN.md "Role and capability gating")
//   'never'     — capability-excluded; never appears in this
//                 staffer's pull dropdown
//
// Inputs:
//   - profile: { role, title }
//   - categoryName: the category being checked
//   - categoryRequiresClinical: boolean (from category_metadata
//     row's is_clinical, or defaults.categories[name].requires_
//     clinical_authorization)
//   - defaults: { routingHubCategory, appTitles } — injected so
//     this function stays pure and per-tenant configurable
//
// Rules (in order):
//   1. APP-tier → 'always' for clinical categories, 'never' for
//      anything else. APP doesn't dabble in non-clinical work.
//   2. Routing Hub → Non-Clinical 'always', Clinical (non-APP)
//      'idle_only'. Non-Clinical is the routing layer; clinical
//      RNs help during quiet clinical periods.
//   3. Other clinical-required categories → Clinical 'always',
//      everyone else 'never'.
//   4. Other non-clinical categories → Non-Clinical 'always',
//      Clinical (non-APP) 'idle_only', anyone else 'never'.
//
// The 'idle_only' state is the asymmetric idle-unlock: clinical
// can spill into non-clinical when their own pool is dry, but
// non-clinical never spills into clinical regardless of load.
function categoryEligibility(profile, categoryName, categoryRequiresClinical, defaults) {
  if (!profile) return 'never';
  const opts = defaults || {};
  const isApp = isAppTier(profile, opts.appTitles);

  // Rule 1: APP tier — clinical work only.
  if (isApp) {
    return categoryRequiresClinical ? 'always' : 'never';
  }

  // Rule 2: Routing Hub.
  if (categoryName === opts.routingHubCategory) {
    if (isNonClinical(profile)) return 'always';
    if (isClinical(profile))    return 'idle_only';
    return 'never';
  }

  // Rule 3: clinical-required category.
  if (categoryRequiresClinical) {
    return isClinical(profile) ? 'always' : 'never';
  }

  // Rule 4: non-clinical, non-routing-hub category.
  if (isNonClinical(profile)) return 'always';
  if (isClinical(profile))    return 'idle_only';
  return 'never';
}

module.exports = {
  // role classifiers
  isClinical,
  isNonClinical,
  isAdmin,
  isSuperUser,
  isAppTier,
  // row classification
  rowIsClinical,
  // composite permission predicates
  canMutateRow,
  canResolveReview,
  canEditClinicalCategory,
  canDeleteRow,
  canVoteOnDraft,
  canSaveActualResponse,
  canMarkEscalated,
  // queue eligibility
  categoryEligibility,
};
