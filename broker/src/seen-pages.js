// Look before acting (approved in 2026-10-22).
//
// Tracks, per agent and per paired browser, the page address each agent last
// saw in every tab. The broker sends this map with each click, press, type, or
// select; the extension refuses the action if the agent has not seen the page
// that is actually in the tab now, and returns a fresh snapshot instead.
//
// Memory-only on purpose: after a broker restart every agent simply looks again.

const MAX_AGENTS = 200;
const MAX_TABS_PER_AGENT = 50;

// Origin plus path, without query string or fragment. Must match the
// extension's listedAddress() so both sides compare the same value.
export function pageAddress(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname}` : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return null; }
}

export class SeenPages {
  constructor() { this.byAgent = new Map(); }

  #key(agentId, browserDigest) { return `${agentId}\u0000${browserDigest}`; }

  record(agentId, browserDigest, tabId, urlOrAddress, { isAddress = false } = {}) {
    if (typeof agentId !== 'string' || !agentId || typeof browserDigest !== 'string' || !browserDigest) return false;
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    const address = isAddress ? (typeof urlOrAddress === 'string' && urlOrAddress ? urlOrAddress : null) : pageAddress(urlOrAddress);
    if (!address) return false;
    const key = this.#key(agentId, browserDigest);
    let tabs = this.byAgent.get(key);
    if (!tabs) {
      tabs = new Map();
      this.byAgent.set(key, tabs);
      while (this.byAgent.size > MAX_AGENTS) this.byAgent.delete(this.byAgent.keys().next().value);
    }
    tabs.delete(tabId);
    tabs.set(tabId, address);
    while (tabs.size > MAX_TABS_PER_AGENT) tabs.delete(tabs.keys().next().value);
    return true;
  }

  // Record from an extension result that carries { page: { tabId, address } }.
  recordPage(agentId, browserDigest, page) {
    if (!page || typeof page !== 'object') return false;
    return this.record(agentId, browserDigest, page.tabId, page.address, { isAddress: true });
  }

  forAgent(agentId, browserDigest) {
    const tabs = this.byAgent.get(this.#key(agentId, browserDigest));
    return Object.fromEntries([...(tabs?.entries() || [])].map(([tabId, address]) => [String(tabId), address]));
  }

  forgetAgent(agentId) {
    for (const key of [...this.byAgent.keys()]) if (key.startsWith(`${agentId}\u0000`)) this.byAgent.delete(key);
  }
}
