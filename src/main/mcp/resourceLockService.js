'use strict';

class ResourceLockService {
  constructor() { this.tails = new Map(); }

  async withLocks(resourceRefs, operation) {
    const refs = [...new Set(resourceRefs.map(String))].sort();
    const releases = [];
    for (const ref of refs) {
      const previous = this.tails.get(ref) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      const tail = previous.then(() => current);
      this.tails.set(ref, tail);
      await previous;
      releases.push(() => {
        release();
        if (this.tails.get(ref) === tail) this.tails.delete(ref);
      });
    }
    try { return await operation(); }
    finally { for (const release of releases.reverse()) release(); }
  }
}

module.exports = { ResourceLockService };
