'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ineligibleCharacters,
  assertFanworkCharacters,
} = require('../src/main/import/characterEnrichmentEligibility');

test('manual enrichment only accepts user-confirmed fanwork characters', () => {
  const fanwork = { id: 'rion', name: '调月莉音', isOriginal: false, sourceWork: '蔚蓝档案' };
  assert.deepEqual(assertFanworkCharacters([fanwork]), [fanwork]);
  assert.deepEqual(ineligibleCharacters([fanwork]), []);
});

test('manual enrichment reports misclassified and unconfirmed characters instead of silently skipping', () => {
  const original = { id: 'rion', name: '调月莉音', isOriginal: true };
  const unconfirmed = { id: 'unknown', name: '未确认角色' };
  assert.deepEqual(ineligibleCharacters([original, unconfirmed]), [original, unconfirmed]);
  assert.throws(
    () => assertFanworkCharacters([original, unconfirmed]),
    (error) => error.message.includes('调月莉音')
      && error.message.includes('未确认角色')
      && error.message.includes('未标记为二创'),
  );
});
