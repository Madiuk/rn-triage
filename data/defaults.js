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
  // dips below this threshold.
  reviewConfidenceThreshold: 0.75,

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
    'Complaint/Concern':     { requires_clinical_authorization: false, kind: 'non_clinical' }
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
