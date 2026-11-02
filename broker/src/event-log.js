const SUCCESS_OUTCOMES = new Set(['ok', 'inspected', 'proposed', 'verified']);

function actionSummary(tool, url) {
  const summaries = {
    edge_click: 'Clicked an element',
    edge_press: 'Pressed a key',
    edge_type: 'Typed into a field',
    edge_scroll: 'Scrolled the page',
    edge_select: 'Selected an option',
    edge_wait: 'Waited for the page',
    edge_find_elements: 'Found page elements',
    edge_screenshot: 'Captured a screenshot',
    edge_snapshot: 'Read the page',
    edge_extract_text: 'Read page text',
    edge_active_tab: 'Read the active tab',
    edge_list_tabs: 'Listed browser tabs',
    edge_list_browsers: 'Listed browsers',
    edge_bridge_status: 'Checked browser status',
    edge_status: 'Checked browser status',
    edge_verified_action_inspect: 'Inspected a verified action',
    edge_verified_action_propose: 'Proposed a verified action',
    edge_verified_action_execute: 'Executed a verified action',
    edge_verified_action_reconcile: 'Reconciled a verified action',
    edge_verified_action_status: 'Checked a verified action',
    edge_verified_receipt: 'Read a verified-action receipt'
  };
  if (tool === 'edge_navigate') {
    try { return `Navigated to ${new URL(url).hostname}`; } catch { return 'Navigated to a page'; }
  }
  return summaries[tool] || 'Completed a browser action';
}

export function summarize({ tool, outcome, url }) {
  if (SUCCESS_OUTCOMES.has(outcome)) return actionSummary(tool, url);
  const reasons = {
    agent_control_busy: 'another agent is using the browser',
    browser_offline: 'the browser is offline',
    browser_unknown: 'the browser is unknown',
    capability_denied: 'the agent lacks permission',
    denied_or_unavailable: 'the action was denied or unavailable',
    failed: 'the action failed',
    human_takeover_active: 'a human is controlling the browser',
    no_default_browser: 'no default browser is set',
    not_found: 'the requested item was not found',
    policy_denied: 'the browsing policy blocked the action',
    unresolved_or_mismatch: 'the action could not be verified',
    validation_failed: 'the request was invalid'
  };
  return `Refused: ${reasons[outcome] || 'the browser action did not complete'}`;
}

export class EventLog {
  constructor({ perBrowser = 1_000, now = () => new Date() } = {}) {
    this.perBrowser = perBrowser;
    this.now = now;
    this.cursor = 0;
    this.events = new Map();
    this.waiters = new Map();
  }

  append(browserDigest, { agentId, type, tool, ok, summary }) {
    const event = Object.freeze({
      cursor: String(++this.cursor),
      at: new Date(this.now()).toISOString(),
      agentId,
      type,
      tool,
      summary,
      ok
    });
    const events = this.events.get(browserDigest) || [];
    events.push(event);
    if (events.length > this.perBrowser) events.splice(0, events.length - this.perBrowser);
    this.events.set(browserDigest, events);
    for (const wake of this.waiters.get(browserDigest) || []) wake();
    return event;
  }

  since(browserDigest, cursor, limit = 100) {
    const after = Number.parseInt(cursor, 10);
    const floor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 100;
    const events = (this.events.get(browserDigest) || []).filter((event) => Number(event.cursor) > floor).slice(0, boundedLimit);
    return { events, next: events.at(-1)?.cursor || String(floor) };
  }

  wait(browserDigest, cursor, ms) {
    const available = this.since(browserDigest, cursor);
    if (available.events.length || ms <= 0) return Promise.resolve(available);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        const waiters = this.waiters.get(browserDigest);
        if (waiters) {
          waiters.delete(finish);
          if (!waiters.size) this.waiters.delete(browserDigest);
        }
        resolve(this.since(browserDigest, cursor));
      };
      const timer = setTimeout(finish, ms);
      const waiters = this.waiters.get(browserDigest) || new Set();
      waiters.add(finish);
      this.waiters.set(browserDigest, waiters);
    });
  }
}
