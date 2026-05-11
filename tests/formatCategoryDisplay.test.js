const { formatCategoryDisplay } = require('../data/triage-lib.js');

describe('formatCategoryDisplay', () => {
  it('returns clinical_category alone when only clinical is set', () => {
    assert.equal(
      formatCategoryDisplay({ clinical_category: 'Side Effects' }),
      'Side Effects'
    );
  });

  it('returns joined non_clinical_items when only non-clinical is set', () => {
    assert.equal(
      formatCategoryDisplay({ non_clinical_items: ['Billing/Payment'] }),
      'Billing/Payment'
    );
    assert.equal(
      formatCategoryDisplay({ non_clinical_items: ['Billing/Payment', 'Shipment/Tracking'] }),
      'Billing/Payment, Shipment/Tracking'
    );
  });

  it('combines both with " · " separator on dual triages', () => {
    assert.equal(
      formatCategoryDisplay({
        clinical_category: 'Side Effects',
        non_clinical_items: ['Shipment/Tracking'],
      }),
      'Side Effects · Shipment/Tracking'
    );
    assert.equal(
      formatCategoryDisplay({
        clinical_category: 'Medication Management',
        non_clinical_items: ['Billing/Payment', 'Account/Subscription'],
      }),
      'Medication Management · Billing/Payment, Account/Subscription'
    );
  });

  it('returns empty string when neither field is set', () => {
    assert.equal(formatCategoryDisplay({}), '');
    assert.equal(formatCategoryDisplay({ clinical_category: '' }), '');
    assert.equal(formatCategoryDisplay({ non_clinical_items: [] }), '');
    assert.equal(formatCategoryDisplay({ clinical_category: null, non_clinical_items: null }), '');
  });

  it('handles null / undefined row', () => {
    assert.equal(formatCategoryDisplay(null), '');
    assert.equal(formatCategoryDisplay(undefined), '');
  });

  it('ignores non-array non_clinical_items (defensive against bad data)', () => {
    // Legacy rows from before the v0.3.1 split fix have
    // non_clinical_items as a string or absent. Don't crash.
    assert.equal(
      formatCategoryDisplay({ clinical_category: 'Side Effects', non_clinical_items: 'not an array' }),
      'Side Effects'
    );
  });

  it('handles a realistic row from query_history', () => {
    var row = {
      id: 'abc-123',
      created_at: '2026-05-10T20:12:00Z',
      clinical_category: null,
      non_clinical_items: ['Billing/Payment'],
      non_clinical_flag: true,
      clinical_routing_level: 'none',
    };
    assert.equal(formatCategoryDisplay(row), 'Billing/Payment');
  });
});
