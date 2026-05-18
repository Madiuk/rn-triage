// data/defaults.js
// Single source of truth for fallback constants. Loaded as a global
// before app.js. The `tenants` table (when populated) overrides these
// at runtime via /auth/profile; if no tenant row is found, RELAI_DEFAULTS
// is the safety net.
//
// Never hardcode a tenant-specific value anywhere else.

const RELAI_DEFAULTS = {
  brand: {
    name: 'Big Easy Weight Loss',
    tag: 'Triage and Tasking',
    primaryColor: '#2563eb'
  },
  models: {
    triage: 'claude-sonnet-4-6',
    correction: 'claude-haiku-4-5'
  },
  // Used by the urgency scoring fallback when the AI omits a value.
  urgency: {
    base: { urgent: 9, 'same-day': 6, routine: 3 },
    severityModifier: { severe: 2, moderate: 1, mild: 0, none: 0 },
    cap: 10
  },
  // Visible to staff when the AI's confidence on a clinical decision
  // dips below this threshold. The Phase-3 worker also uses this
  // threshold to override clinical_category → 'Routing Hub' so that
  // low-confidence tasks land in the non-clinical routing pool rather
  // than the AI's best-guess category. See PLAN.md "Task ownership,
  // assignment, and handoffs" rule 8.
  reviewConfidenceThreshold: 0.75,

  // Tasks with urgency_score at or above this threshold are pulled
  // FIRST in /queue/pull, across all ticked categories, regardless of
  // category gating or Due state. The urgency_score column is 0–10
  // (see RELAI_DEFAULTS.urgency above for how it's derived). 7 is
  // chosen as a starting point — adjust based on real volume after
  // go-live. See PLAN.md "Per-staff queue" priority ordering.
  severityUrgencyThreshold: 7,

  // Special category name used when the AI's confidence is below
  // reviewConfidenceThreshold. The worker overrides clinical_category
  // to this value so the task lands in the non-clinical Routing Hub
  // pool. APP-tier staff are excluded from this pool; clinical RN
  // staff can pull from it via the idle-unlock rule when their
  // in-scope clinical pool is empty.
  routingHubCategory: 'Routing Hub',

  // Staff `title` values that classify as advanced-practice provider
  // (APP) tier. APP attention is reserved for clinical work, so APP
  // staff are excluded from the Routing Hub and from non-clinical
  // categories. Big Easy default; per-tenant override expected in
  // Phase 4 when title taxonomy becomes vertical-specific.
  appTitles: ['MD', 'NP', 'DO', 'PA'],

  // External-system deep-link templates. `{patient_id}` is substituted
  // by the SPA at render time with the value of query_history.bask_patient_id
  // (Bask's identifier for the patient, captured from the Intercom webhook
  // contact's external_id field — see migration 0034). When the column is
  // NULL on a row, no link is rendered. Per-tenant override expected in
  // Phase 4: a non-Bask tenant would either point this at their own EHR's
  // patient-detail URL or set it to null to hide the link.
  externalSystems: {
    bask: {
      adminPatientUrlTemplate: 'https://big-easy-weight-loss.mybaskhealth.com/admin/patients/{patient_id}',
      // Driven by query_history.bask_master_id (Bask's Master ID, mig
      // 0035). Captured by enriching each new Intercom conversation
      // via the contact's custom_attributes["order id"] field.
      adminOrderUrlTemplate: 'https://big-easy-weight-loss.mybaskhealth.com/admin/orders/{master_id}',
    },
  },

  // KB section render order + labels. Single source of truth used by
  // both app.js's getFullKB() (browser, what the live triage call
  // sends) and eval/run.js's buildKBString (the eval harness). Keeping
  // them in lockstep means the eval's kb_version hash matches what
  // production stamps on rows; if it ever doesn't, that's the signal
  // that someone changed one and forgot the other. Tenants will
  // override this list in Phase 4 when KBs become per-tenant
  // structurally (e.g., a non-medical tenant won't have a "Side
  // Effect Guidance" section).
  kb_sections: [
    { key: 'notes',       label: 'CLINICAL RULES (read first)' },
    { key: 'routing',     label: 'ROUTING RULES' },
    { key: 'sideeffects', label: 'SIDE EFFECT GUIDANCE' },
    { key: 'templates',   label: 'RESPONSE TEMPLATES' },
    { key: 'protocols',   label: 'PROTOCOLS' },
    { key: 'urls',        label: 'URLS' },
    { key: 'style',       label: 'WRITING STYLE -- STRICT (these rules override any default formatting habits; apply them to draft_response and internal_note every time)' }
  ],

  // Per-category metadata. The flag we care about today is
  // `requires_clinical_authorization` — whether a staff member needs
  // licensed-clinician status to resolve a task in this category.
  // The future routing/queue layer will use this to gate which
  // queues a category appears in; the AI does NOT read this — its job
  // is purely to categorize accurately.
  //
  // Defaults are conservative: when in doubt, require clinical
  // authorization. It's safer to over-gate (a few extra reassignments
  // by staff) than under-gate (a billing rep accidentally resolving
  // something that needed a clinician).
  //
  // Tenants can override per category via tenants.category_metadata
  // when that table column lands. Until then, this is the source of
  // truth for Big Easy Weight Loss.
  categories: {
    'Severe Side Effects':   { requires_clinical_authorization: true,  kind: 'clinical' },
    'Side Effects':          { requires_clinical_authorization: true,  kind: 'clinical' },
    'Injection/Dosing':      { requires_clinical_authorization: true,  kind: 'clinical' },
    'Medication Management': { requires_clinical_authorization: true,  kind: 'clinical' },
    'Stall/Lack of Results': { requires_clinical_authorization: true,  kind: 'clinical' },
    // Vague / mixed — conservative default. The future gate will also
    // look at clinical_routing_level so a "General Inquiry" with
    // routing_level=none routes to non-clinical staff anyway.
    'General Inquiry':       { requires_clinical_authorization: true,  kind: 'mixed' },
    'Billing/Payment':       { requires_clinical_authorization: false, kind: 'non_clinical' },
    'Shipment/Tracking':     { requires_clinical_authorization: false, kind: 'non_clinical' },
    'Account/Subscription':  { requires_clinical_authorization: false, kind: 'non_clinical' },
    'Refund Request':        { requires_clinical_authorization: false, kind: 'non_clinical' },
    'Complaint/Concern':     { requires_clinical_authorization: false, kind: 'non_clinical' },
    // Routing Hub — the pool low-confidence AI classifications land
    // in. Non-clinical by capability; APP exclusion is enforced at
    // the pull endpoint, not here (see permissions.categoryEligibility).
    'Routing Hub':           { requires_clinical_authorization: false, kind: 'non_clinical' }
  }
};

// Resolve a tenant value with fallback. Pass an object from the
// /auth/profile response (profile.tenant) and a dotted key path.
//   tenantValue(profile.tenant, 'brand.name')
function tenantValue(tenant, path) {
  var segments = path.split('.');
  var fromTenant = segments.reduce(function(o, k){
    return (o && o[k] !== undefined) ? o[k] : undefined;
  }, tenant || {});
  if (fromTenant !== undefined && fromTenant !== null && fromTenant !== '') {
    return fromTenant;
  }
  return segments.reduce(function(o, k){ return o ? o[k] : undefined; }, RELAI_DEFAULTS);
}

// Node export hook — no-op in the browser. Lets tests and the eval
// harness pull RELAI_DEFAULTS without needing a script-tag bootstrap.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RELAI_DEFAULTS, tenantValue };
}
