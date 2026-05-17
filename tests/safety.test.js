// tests/safety.test.js
//
// Unit tests for the runtime safety gate(s) in
// netlify/functions/_lib/safety.js. The gate is small and central:
// it controls whether outbound-to-patient channels (intercom,
// healthie, bask, email) can actually fire a network call. The
// integration with /queue/send → dispatchOutbound lives in
// tests/queue.test.js — this file only pins the predicate itself.

const { isOutboundLiveMode } = require('../netlify/functions/_lib/safety.js');

describe('isOutboundLiveMode', () => {
  // Each test saves and restores the env var so state doesn't leak
  // between tests (the runner serializes tests but they share process).
  const KEY = 'OUTBOUND_LIVE_MODE';

  it('returns false when the env var is unset', () => {
    const prior = process.env[KEY];
    try {
      delete process.env[KEY];
      assert.equal(isOutboundLiveMode(), false);
    } finally {
      if (prior !== undefined) process.env[KEY] = prior;
    }
  });

  it('returns true only for the literal string "true"', () => {
    const prior = process.env[KEY];
    try {
      process.env[KEY] = 'true';
      assert.equal(isOutboundLiveMode(), true);
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });

  it('rejects "True", "TRUE", and other casings (conservative)', () => {
    const prior = process.env[KEY];
    try {
      for (const v of ['True', 'TRUE', 'tRuE', ' true', 'true ']) {
        process.env[KEY] = v;
        assert.equal(isOutboundLiveMode(), false, 'should reject: ' + JSON.stringify(v));
      }
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });

  it('rejects truthy-looking values: "1", "yes", "on"', () => {
    const prior = process.env[KEY];
    try {
      for (const v of ['1', 'yes', 'on', 'enabled', 'live']) {
        process.env[KEY] = v;
        assert.equal(isOutboundLiveMode(), false, 'should reject: ' + JSON.stringify(v));
      }
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });

  it('returns false for "false", "0", empty string, and other negatives', () => {
    const prior = process.env[KEY];
    try {
      for (const v of ['false', '0', '', 'no', 'off']) {
        process.env[KEY] = v;
        assert.equal(isOutboundLiveMode(), false);
      }
    } finally {
      if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior;
    }
  });
});
