'use strict';

const assert = require('node:assert/strict');
const { appError, normalizeAppError } = require('../src/main/appError');

const dns = normalizeAppError(Object.assign(new Error('getaddrinfo ENOTFOUND relay.example'), { code: 'ENOTFOUND' }), { domain: 'relay', phase: 'feedback_sync' });
assert.deepEqual({ code: dns.code, retryable: dns.retryable, userAction: dns.userAction, reasonKind: dns.reasonKind }, {
  code: 'relay_unreachable', retryable: true, userAction: 'retry', reasonKind: 'dns',
});
assert.match(dns.diagnosticId, /^diag-/u);

const timeout = normalizeAppError(Object.assign(new Error('aborted'), { name: 'AbortError' }), { domain: 'auth', phase: 'auth_exchange' });
assert.equal(timeout.code, 'relay_timeout');
assert.equal(timeout.domain, 'auth');

const legacy = normalizeAppError({ code: 'missing_relay_config' }, { domain: 'relay' });
assert.equal(legacy.code, 'relay_config_missing');
assert.equal(legacy.userAction, 'configure_relay');

const publicError = appError({ code: 'provider_protocol_mismatch' }, { phase: 'provider_response' });
assert.equal(publicError.code, 'provider_protocol_mismatch');
assert.equal(publicError.message.includes('provider_protocol_mismatch'), false);
assert.equal(publicError.appError.schemaVersion, 1);

console.log('TEST_PASS app-error-regression');
