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
  reviewConfidenceThreshold: 0.75
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
