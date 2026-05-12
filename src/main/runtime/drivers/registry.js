'use strict';

/**
 * Driver registry.
 *
 * Holds the set of installed AgentRuntimeDriver instances and provides:
 *   - register(driver)      add to registry (idempotent — last write wins by id)
 *   - list()                ordered driver info list (priority order)
 *   - get(id)               retrieve a specific driver
 *   - getActive()           current active driver (resolves from appConfig)
 *   - setActive(id)         persist new active driver in appConfig and emit
 *                           a 'runtime:changed' renderer event
 *   - capabilities(id)      driver.capabilities()
 *   - availability(id)      driver.availability() (may spawn child probe)
 *   - listInfo()            list with capabilities + availability merged
 *
 * The registry does NOT perform driver discovery itself. `bootstrap()` registers
 * the canonical drivers in priority order; bringing up a new driver = adding a
 * line in `bootstrap()` (and shipping the implementation file).
 */

const appConfig = require('../../store/appConfig');

/** @type {Map<string, import('./driver.d.js').AgentRuntimeDriver>} */
const drivers = new Map();
/** Insertion-order id list — drives UI ordering. */
const order = [];
let bootstrapped = false;

let webContentsRef = null;
function setWebContents(wc) {
  webContentsRef = wc;
}

function emitChanged() {
  if (webContentsRef && !webContentsRef.isDestroyed?.()) {
    try {
      webContentsRef.send('runtime:changed', { ts: Date.now() });
    } catch (err) {
      console.error('[driverRegistry] emit failed', err);
    }
  }
}

function register(driver) {
  if (!driver || typeof driver.id !== 'string') {
    throw new Error('register: driver must have a string id');
  }
  if (!drivers.has(driver.id)) order.push(driver.id);
  drivers.set(driver.id, driver);
}

function get(id) {
  return drivers.get(id) || null;
}

/**
 * Return drivers in registration order with basic info only (id / displayName /
 * description). Use listInfoAsync() if capabilities/availability are needed.
 */
function list() {
  return order.map((id) => {
    const d = drivers.get(id);
    return { id: d.id, displayName: d.displayName, description: d.description || '' };
  });
}

async function listInfoAsync() {
  const result = [];
  for (const id of order) {
    const d = drivers.get(id);
    let availability = { available: false, reason: 'not probed' };
    let caps = null;
    try { availability = await d.availability(); } catch (err) {
      availability = { available: false, reason: err.message || String(err) };
    }
    try { caps = d.capabilities(); } catch (err) {
      caps = null;
    }
    result.push({
      id: d.id,
      displayName: d.displayName,
      description: d.description || '',
      capabilities: caps,
      availability,
    });
  }
  return result;
}

async function getActive() {
  const cfg = await appConfig.load();
  const id = cfg.activeDriverId || 'direct-api';
  return drivers.get(id) || drivers.get('direct-api') || null;
}

async function getActiveId() {
  const cfg = await appConfig.load();
  return cfg.activeDriverId || 'direct-api';
}

async function setActive(id) {
  if (!drivers.has(id)) throw new Error(`unknown driver: ${id}`);
  const cfg = await appConfig.load();
  if (cfg.activeDriverId === id) return cfg;
  const next = await appConfig.save({ activeDriverId: id });
  emitChanged();
  return next;
}

async function capabilities(id) {
  const d = drivers.get(id);
  if (!d) throw new Error(`unknown driver: ${id}`);
  return d.capabilities();
}

async function availability(id) {
  const d = drivers.get(id);
  if (!d) throw new Error(`unknown driver: ${id}`);
  return d.availability();
}

/**
 * Register the canonical drivers. Idempotent. Subsequent calls do nothing.
 *
 * Order matters — UI lists drivers in this order, and getActive() falls back to
 * 'direct-api' if no active id is set.
 *
 * Note: claude-code-vscode / claude-code-cli / codex are stubs in Phase 5 — they
 * register but report unavailable. They become real implementations in Phase 7+.
 */
function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  // Order: vscode → cli → codex → direct-api (matches user-specified priority).
  try { register(require('./claudeCodeVscode')); } catch (err) {
    console.error('[driverRegistry] vscode driver load failed', err);
  }
  try { register(require('./claudeCodeCli')); } catch (err) {
    console.error('[driverRegistry] cli driver load failed', err);
  }
  try { register(require('./codex')); } catch (err) {
    console.error('[driverRegistry] codex driver load failed', err);
  }
  try { register(require('./directApi')); } catch (err) {
    console.error('[driverRegistry] direct-api driver load failed', err);
  }
}

module.exports = {
  register,
  get,
  list,
  listInfoAsync,
  getActive,
  getActiveId,
  setActive,
  capabilities,
  availability,
  bootstrap,
  setWebContents,
};
