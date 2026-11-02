const DEFAULT_TTL_MS = 15 * 60_000;

function identity(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function browser(value) {
  // This is an internal broker value derived from the authenticated paired
  // extension token, never a request parameter. Keep the lease testable with
  // opaque queue identities while refusing absent or unbounded values.
  if (typeof value !== 'string' || !value || value.length > 200) throw new TypeError('browser instance is unavailable');
  return value;
}

// Deliberately memory-only: a broker crash clears control rather than replaying
// a stale human session. Each paired browser has an independent lease.
export class BrowserHandoffLease {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) throw new TypeError('handoff TTL is invalid');
    this.now = now;
    this.ttlMs = ttlMs;
    this.leases = new Map();
  }

  #clearIfStale(browserId) {
    const lease = this.leases.get(browserId);
    if (lease && lease.expiresAt <= this.now()) this.leases.delete(browserId);
  }

  status({ browserId, activeAgentIdentity = null }) {
    if (browserId !== null && browserId !== undefined) browserId = browser(browserId);
    this.#clearIfStale(browserId);
    const lease = this.leases.get(browserId);
    if (!lease) return Object.freeze({ claimed: false, browserInstance: browserId || null, controllerIdentity: null, activeAgentIdentity: activeAgentIdentity || null, expiresAt: null });
    return Object.freeze({ claimed: true, browserInstance: lease.browserId, controllerIdentity: lease.controllerIdentity, activeAgentIdentity: activeAgentIdentity || lease.activeAgentIdentity || null, expiresAt: new Date(lease.expiresAt).toISOString() });
  }

  claim({ browserId, controllerIdentity, activeAgentIdentity = null }) {
    browserId = browser(browserId);
    controllerIdentity = identity(controllerIdentity, 'controller identity');
    this.#clearIfStale(browserId);
    const lease = this.leases.get(browserId);
    if (lease && lease.controllerIdentity !== controllerIdentity) throw new Error('browser is already controlled by another authenticated human');
    this.leases.set(browserId, Object.freeze({ browserId, controllerIdentity, activeAgentIdentity: typeof activeAgentIdentity === 'string' ? identity(activeAgentIdentity, 'agent identity') : null, expiresAt: this.now() + this.ttlMs }));
    return this.status({ browserId, activeAgentIdentity });
  }

  release({ browserId, controllerIdentity, activeAgentIdentity = null }) {
    browserId = browser(browserId);
    controllerIdentity = identity(controllerIdentity, 'controller identity');
    this.#clearIfStale(browserId);
    const lease = this.leases.get(browserId);
    if (lease && lease.controllerIdentity !== controllerIdentity) throw new Error('only the claiming controller may release this browser');
    if (lease) this.leases.delete(browserId);
    return this.status({ browserId, activeAgentIdentity });
  }

  assertAgentMayMutate(browserId) {
    browserId = browser(browserId);
    this.#clearIfStale(browserId);
    if (this.leases.has(browserId)) throw new Error('human takeover active for this browser');
  }
}
