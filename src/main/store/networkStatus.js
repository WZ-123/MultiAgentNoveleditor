'use strict';

/**
 * Network status tracker — main process mirror of renderer's navigator.onLine.
 * The renderer reports its online/offline state via IPC; we store it here
 * so that backend operations (novel writes, MCP tool calls) can decide
 * whether to append an offline-log entry.
 */

let _status = 'unknown'; // 'online' | 'offline' | 'disconnected' | 'unknown'

function set(status) {
  _status = status;
}

function get() {
  return _status;
}

function isOffline() {
  return _status === 'offline' || _status === 'disconnected';
}

module.exports = { set, get, isOffline };
