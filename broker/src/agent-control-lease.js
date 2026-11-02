const DEFAULT_IDLE_MS = 30_000;
const MIN_IDLE_MS = 1_000;
const MAX_IDLE_MS = 600_000;

export function idleMsFromEnv(env = process.env) {
  const value = Number(env.WORK_EDGE_AGENT_CONTROL_IDLE_MS);
  return Number.isInteger(value) && value >= MIN_IDLE_MS && value <= MAX_IDLE_MS ? value : DEFAULT_IDLE_MS;
}

function required(value, name) {
  if (typeof value !== 'string' || !value || value.length > 200) throw new TypeError(`${name} is unavailable`);
  return value;
}

// Memory-only, like BrowserHandoffLease: a broker restart clears agent control.
// Each paired browser has an independent holder whose lease renews on action.
export class AgentControlLease {
  constructor({ now = () => Date.now(), idleMs = DEFAULT_IDLE_MS } = {}) {
    this.now = now;
    this.idleMs = idleMs;
    this.leases = new Map();
  }

  #clearIfStale(browserId) {
    const lease = this.leases.get(browserId);
    if (lease && lease.expiresAt <= this.now()) this.leases.delete(browserId);
  }

  status({ browserId }) {
    this.#clearIfStale(browserId);
    const lease = this.leases.get(browserId);
    if (!lease) return { holder: null, expiresAt: null };
    return { holder: lease.agentId, expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  acquire({ browserId, agentId }) {
    browserId = required(browserId, 'browser instance');
    agentId = required(agentId, 'agent identity');
    this.#clearIfStale(browserId);
    const lease = this.leases.get(browserId);
    if (lease && lease.agentId !== agentId) {
      return { granted: false, holder: lease.agentId, retryAfterMs: lease.expiresAt - this.now(), expiresAt: new Date(lease.expiresAt).toISOString() };
    }
    const renewed = { agentId, expiresAt: this.now() + this.idleMs };
    this.leases.set(browserId, renewed);
    return { granted: true, holder: agentId, expiresAt: new Date(renewed.expiresAt).toISOString() };
  }
}
