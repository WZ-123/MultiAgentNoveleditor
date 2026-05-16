'use strict';

/**
 * In-memory lock for sync worker. Electron main process is a single
 * process, so a Map is sufficient. Crashes naturally release all locks.
 */

const locks = new Map();

function acquire(key) {
  if (locks.has(key)) return false;
  locks.set(key, Date.now());
  return true;
}

function release(key) {
  return locks.delete(key);
}

function isLocked(key) {
  return locks.has(key);
}

function lockedKeys() {
  return Array.from(locks.keys());
}

function clearAll() {
  locks.clear();
}

module.exports = { acquire, release, isLocked, lockedKeys, clearAll };
