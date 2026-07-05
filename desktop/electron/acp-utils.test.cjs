// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPermissionResponse, buildElicitationResponse } = require('./acp-utils.cjs');

test('ACP permission responses select explicit and fallback options', () => {
  assert.deepEqual(buildPermissionResponse({ optionId: 'allow-once' }), {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.deepEqual(buildPermissionResponse({}), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
});

test('ACP permission responses can cancel pending requests', () => {
  assert.deepEqual(buildPermissionResponse({ cancelled: true }), {
    outcome: { outcome: 'cancelled' },
  });
});

test('ACP elicitation responses preserve accepted content and non-accept actions', () => {
  assert.deepEqual(buildElicitationResponse({ action: 'accept', content: { name: 'value' } }), {
    action: 'accept',
    content: { name: 'value' },
  });
  assert.deepEqual(buildElicitationResponse({ action: 'decline' }), { action: 'decline' });
  assert.deepEqual(buildElicitationResponse({ action: 'cancel' }), { action: 'cancel' });
});

test('ACP elicitation responses reject invalid actions', () => {
  assert.throws(() => buildElicitationResponse({ action: 'bogus' }), /valid elicitation action/);
});
