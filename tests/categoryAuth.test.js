const { requiresClinicalAuthorization } = require('../data/triage-lib.js');
const { RELAI_DEFAULTS } = require('../data/defaults.js');

describe('requiresClinicalAuthorization (helper)', () => {
  const meta = {
    'Side Effects':    { requires_clinical_authorization: true,  kind: 'clinical' },
    'Billing/Payment': { requires_clinical_authorization: false, kind: 'non_clinical' },
  };

  it('returns the explicit boolean for a mapped category', () => {
    assert.equal(requiresClinicalAuthorization('Side Effects',    meta), true);
    assert.equal(requiresClinicalAuthorization('Billing/Payment', meta), false);
  });

  it('defaults to true for unmapped categories', () => {
    // A category we've never seen before should NOT bypass the
    // clinical gate by accident. Conservative is safer.
    assert.equal(requiresClinicalAuthorization('Telepathy', meta), true);
  });

  it('defaults to true for empty / null / undefined input', () => {
    assert.equal(requiresClinicalAuthorization('',         meta), true);
    assert.equal(requiresClinicalAuthorization(null,       meta), true);
    assert.equal(requiresClinicalAuthorization(undefined,  meta), true);
  });

  it('defaults to true when no metadata object is supplied', () => {
    assert.equal(requiresClinicalAuthorization('Side Effects'), true);
    assert.equal(requiresClinicalAuthorization('Side Effects', null), true);
    assert.equal(requiresClinicalAuthorization('Side Effects', {}), true);
  });

  it('trims whitespace before lookup', () => {
    assert.equal(requiresClinicalAuthorization('  Side Effects  ', meta), true);
  });

  it('ignores entries with non-boolean flags (treats as unmapped)', () => {
    const bad = { 'Side Effects': { requires_clinical_authorization: 'yes' } };
    // String 'yes' is not a boolean — falls through to the conservative
    // default of true. (Same outcome here, but the path is different.)
    assert.equal(requiresClinicalAuthorization('Side Effects', bad), true);
  });
});

describe('RELAI_DEFAULTS.categories (live data)', () => {
  // These tests pin the actual tenant defaults so a careless edit to
  // defaults.js can't silently flip the gate on a clinical category.
  // If you genuinely need to relax one of these, update both the data
  // and the assertion in the same commit.
  const cats = RELAI_DEFAULTS.categories;

  it('exists and is an object', () => {
    assert.equal(typeof cats, 'object');
    assert.notEqual(cats, null);
  });

  it('every clinical category requires clinical authorization', () => {
    [
      'Severe Side Effects',
      'Side Effects',
      'Injection/Dosing',
      'Medication Management',
      'Stall/Lack of Results',
    ].forEach(c => {
      assert.ok(cats[c], 'missing category: ' + c);
      assert.equal(cats[c].requires_clinical_authorization, true, c + ' should require clinical auth');
      assert.equal(cats[c].kind, 'clinical', c + ' should be kind=clinical');
    });
  });

  it('non-clinical operational categories do NOT require clinical auth', () => {
    [
      'Billing/Payment',
      'Shipment/Tracking',
      'Account/Subscription',
      'Refund Request',
      'Complaint/Concern',
    ].forEach(c => {
      assert.ok(cats[c], 'missing category: ' + c);
      assert.equal(cats[c].requires_clinical_authorization, false, c + ' should not require clinical auth');
      assert.equal(cats[c].kind, 'non_clinical', c + ' should be kind=non_clinical');
    });
  });

  it('General Inquiry is gated conservatively (requires auth)', () => {
    // The vague-default category MUST require clinical auth so we
    // never accidentally route an under-categorized clinical message
    // to a non-clinical resolver. Future gate logic can relax based
    // on clinical_routing_level.
    assert.equal(cats['General Inquiry'].requires_clinical_authorization, true);
    assert.equal(cats['General Inquiry'].kind, 'mixed');
  });

  it('every category has both required fields', () => {
    Object.keys(cats).forEach(name => {
      const c = cats[name];
      assert.equal(typeof c.requires_clinical_authorization, 'boolean',
        name + '.requires_clinical_authorization must be a boolean');
      assert.ok(['clinical', 'non_clinical', 'mixed'].includes(c.kind),
        name + '.kind must be one of clinical|non_clinical|mixed');
    });
  });
});
