'use strict';

const crypto = require('node:crypto');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function hash(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(input == null ? 'null' : input).digest('hex');
}
function contractError(message, code = 'codex_protocol_error', details = null) {
  const error = new Error(String(message || code));
  error.code = code;
  if (details != null) error.details = clone(details);
  return error;
}

module.exports = { clone, contractError, hash };
