'use strict';

const subscribers = new Set();

function emit(channel, payload) {
  if (!channel) return;
  for (const fn of subscribers) {
    try {
      fn({ channel, payload, ts: Date.now() });
    } catch (err) {
      console.error('[clientEvents] subscriber failed', err);
    }
  }
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { emit, subscribe };
