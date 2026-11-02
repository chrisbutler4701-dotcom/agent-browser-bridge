import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// An MV3 worker can need up to the next 30-second durable wakeup to restore
// its command transport after suspension. Keep the default within the existing
// one-minute hard cap so a safe command is not discarded before recovery.
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_WAIT_MS = 25_000;
export const MAX_POLL_WAIT_MS = 30_000;
export const BROWSER_ONLINE_WINDOW_MS = 15_000;
const DEFAULT_STATE_FILE = process.env.WORK_EDGE_COMMAND_STATE || '/etc/work-edge/command-state.json';
const COMMAND_TYPES = { edge_click: 'click', edge_press: 'press', edge_type: 'type', edge_scroll: 'scroll', edge_select: 'select', edge_navigate: 'navigate', edge_wait: 'wait', edge_find_elements: 'find', edge_screenshot: 'screenshot', edge_approve_sensitive_read: 'approve_sensitive_read', edge_set_sensitive_read_restricted: 'set_sensitive_read_restricted', edge_set_control_enabled: 'set_control_enabled', edge_list_open_tabs: 'list_tabs', edge_read_tab: 'read_tab', edge_open_tab: 'open_tab', edge_activate_tab: 'activate_tab', edge_close_tab: 'close_tab' };
// Tab management (approved in 2026-10-22): agents may read, act on, open,
// switch, and close any tab by explicit id. A named tab is never substituted.
const TAB_REQUIRED = new Set(['read_tab', 'activate_tab', 'close_tab']);
export function isValidTabId(value) { return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647; }
const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const PRESS_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace']);
const FINAL_ACTION = /\b(?:send|submit|apply(?![\s_-]+filters?\b)|post|repost|publish|share|like|unlike|follow|unfollow|delete|remove|buy|purchase|checkout|place[\s_-]+order|pay|e-?sign|sign|confirm|upload)\b/i;
// Live lookup is intentionally a small CSS subset. It is enough for common
// mail rows while ruling out combinators, pseudos, IDs, and script-like input.
const SIMPLE_LIVE_SELECTOR = /^(?:\*|[a-z][a-z0-9-]*|\[(?:role|aria-label|data-automationid)(?:\*?=(?:"[^"]{1,120}"|'[^']{1,120}'|[a-z0-9_ -]{1,120}))?\])$/i;

export function isSimpleLiveSelector(selector) {
  if (typeof selector !== 'string' || !selector.length || selector.length > 256) return false;
  const scoped = /^fbb-frame:[1-9]\d*::(.+)$/.exec(selector);
  return SIMPLE_LIVE_SELECTOR.test(scoped ? scoped[1] : selector);
}

function newCommandId() { return randomBytes(8).toString('hex'); }
function normalizeTarget(args) {
  if (typeof args.ref === 'string' && args.ref.trim()) return { ref: args.ref.trim().slice(0, 200) };
  if (typeof args.selector === 'string' && args.selector.trim()) return { selector: args.selector.trim().slice(0, 512) };
  if (typeof args.targetText === 'string' && args.targetText.trim()) return { targetText: args.targetText.trim().slice(0, 200), ...(typeof args.near === 'string' && args.near.trim() ? { near: args.near.trim().slice(0, 200) } : {}) };
  return null;
}
export function isFinalAction(type, target, url) {
  if (type === 'navigate' || type === 'open_tab') {
    try { const address = new URL(url); return FINAL_ACTION.test(`${address.pathname} ${address.search}`); }
    catch { return FINAL_ACTION.test(url || ''); }
  }
  return (type === 'click' || type === 'press') && FINAL_ACTION.test(Object.values(target || {}).join(' '));
}
function validState(value) { return value && typeof value === 'object' && Array.isArray(value.records) ? value : { version: 2, records: [], sequenceByBrowser: {} }; }

export function boundedTimeout(value, fallback = DEFAULT_COMMAND_TIMEOUT_MS, max = MAX_COMMAND_TIMEOUT_MS) { const timeout = Number(value); return !Number.isFinite(timeout) || timeout <= 0 ? fallback : Math.min(timeout, max); }
export function buildCommand(name, args = {}) {
  const type = COMMAND_TYPES[name];
  if (!type) return { error: 'Unsupported browser command.' };
  const target = normalizeTarget(args);
  if (args.near !== undefined && (typeof args.near !== 'string' || args.near.length > 200 || !args.near.trim() || !target?.targetText)) return { error: `${name} near requires targetText and at most 200 characters.` };
  if ((type === 'click' || type === 'type' || type === 'select') && !target) return { error: `${name} requires a selector, targetText, or ref to locate the element.` };
  if (type === 'press' && args.key !== undefined && !PRESS_KEYS.has(args.key)) return { error: `edge_press key must be one of: ${[...PRESS_KEYS].join(', ')}.` };
  if (type === 'press' && typeof args.key !== 'string') return { error: 'edge_press requires a supported key.' };
  if (type === 'type' && (typeof args.text !== 'string' || !args.text.length)) return { error: 'edge_type requires text to insert.' };
  if (type === 'type' && args.text.length > 4000) return { error: 'edge_type text exceeds the configured limit.' };
  if (type === 'select' && typeof args.value !== 'string' && typeof args.optionText !== 'string') return { error: 'edge_select requires a value or optionText.' };
  if (type === 'scroll' && args.direction !== undefined && !SCROLL_DIRECTIONS.has(args.direction)) return { error: 'edge_scroll direction must be up, down, left, or right.' };
  if (type === 'scroll' && args.amount !== undefined && (!Number.isFinite(args.amount) || args.amount <= 0)) return { error: 'edge_scroll amount must be a positive number.' };
  if (type === 'wait' && (!Number.isInteger(args.ms) || args.ms <= 0 || args.ms > 30_000)) return { error: 'edge_wait ms must be an integer from 1 to 30000.' };
  if (type === 'navigate' && (typeof args.url !== 'string' || !args.url.trim())) return { error: 'edge_navigate requires a url.' };
  if (type === 'find' && args.scope !== 'live') return { error: 'Live element discovery requires scope: "live".' };
  if (type === 'find' && !isSimpleLiveSelector(args.selector)) return { error: 'Live element discovery accepts only a bounded simple selector.' };
  if (type === 'set_sensitive_read_restricted' && typeof args.restricted !== 'boolean') return { error: 'edge_set_sensitive_read_restricted requires restricted to be boolean.' };
  if (type === 'set_control_enabled' && typeof args.enabled !== 'boolean') return { error: 'edge_set_control_enabled requires enabled to be boolean.' };
  if (args.tabId !== undefined && !isValidTabId(args.tabId)) return { error: `${name} tabId must be a tab id from edge_list_open_tabs.` };
  if (TAB_REQUIRED.has(type) && args.tabId === undefined) return { error: `${name} requires a tabId from edge_list_open_tabs.` };
  if (type === 'open_tab' && args.url !== undefined && (typeof args.url !== 'string' || !args.url.trim())) return { error: 'edge_open_tab url must be a non-empty address when given.' };
  if (type === 'open_tab' && args.active !== undefined && typeof args.active !== 'boolean') return { error: 'edge_open_tab active must be true or false.' };
  const url = type === 'navigate' || (type === 'open_tab' && typeof args.url === 'string') ? args.url.trim() : undefined;
  return { command: Object.freeze({ id: newCommandId(), type, target, selector: type === 'find' ? args.selector : undefined, key: type === 'press' ? args.key : undefined, text: type === 'type' ? args.text : undefined, value: type === 'select' ? args.value : undefined, optionText: type === 'select' ? args.optionText : undefined, direction: type === 'scroll' ? (args.direction || 'down') : undefined, amount: type === 'scroll' ? (args.amount || 400) : undefined, ms: type === 'wait' ? args.ms : undefined, url, restricted: type === 'set_sensitive_read_restricted' ? args.restricted : undefined, enabled: type === 'set_control_enabled' ? args.enabled : undefined, tabId: args.tabId, maxCharacters: type === 'read_tab' ? args.maxCharacters : undefined, active: type === 'open_tab' ? args.active === true : undefined, finalAction: isFinalAction(type, target, url), approved: false, createdAt: new Date().toISOString() }) };
}

export class BrowserCommandQueue {
  constructor({ now = () => Date.now(), onlineWindowMs = BROWSER_ONLINE_WINDOW_MS, stateFile = DEFAULT_STATE_FILE } = {}) { this.now = now; this.onlineWindowMs = onlineWindowMs; this.stateFile = stateFile; this.sessions = new Map(); this.state = this.#readState(); }
  #readState() { if (!this.stateFile || !existsSync(this.stateFile)) return validState(); try { return validState(JSON.parse(readFileSync(this.stateFile, 'utf8'))); } catch { throw new Error('Command state store is unreadable.'); } }
  #save() { if (!this.stateFile) return; if (this.state.records.length > 500) { const active = this.state.records.filter((r) => ['queued', 'delivered', 'received'].includes(r.state)); const terminal = this.state.records.filter((r) => !['queued', 'delivered', 'received'].includes(r.state)); this.state.records = [...terminal.slice(-200), ...active]; } mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 }); const temporary = `${this.stateFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`; writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, this.stateFile); chmodSync(this.stateFile, 0o600); }
  #session(token) { let session = this.sessions.get(token); if (!session) { session = { lastSeenAt: 0, controlEnabled: false, extensionVersion: null, runnerDiagnostic: null, pollWaiters: [], resultWaiters: new Map(), transportDegraded: false, transportFailureReason: null }; this.sessions.set(token, session); } return session; }
  #records(token) { return this.state.records.filter((record) => record.browserId === token); }
  #expire() { let changed = false; for (const record of this.state.records) if (['queued', 'delivered', 'received'].includes(record.state) && record.expiresAt <= this.now()) { record.state = 'expired'; record.updatedAt = new Date(this.now()).toISOString(); changed = true; } if (changed) this.#save(); }
  markOnline(token, controlEnabled, extensionVersion, runnerDiagnostic) {
    if (!token) return false;
    const session = this.#session(token); session.lastSeenAt = this.now();
    if (typeof controlEnabled === 'boolean') session.controlEnabled = controlEnabled;
    if (typeof extensionVersion === 'string' && /^\d+\.\d+\.\d+$/.test(extensionVersion)) session.extensionVersion = extensionVersion;
    if (['offscreen_absent', 'runner_configured_unacknowledged', 'websocket_active', 'polling_recovery_active', 'no_viable_command_transport'].includes(runnerDiagnostic)) { session.runnerDiagnostic = runnerDiagnostic; if (runnerDiagnostic === 'websocket_active' || runnerDiagnostic === 'polling_recovery_active') this.markTransportRecovered(token); }
    return true;
  }
  // A WebSocket can disappear while its last heartbeat is still within the
  // online window. Clear that lease immediately so MCP does not enqueue a
  // command to a browser that has no transport to receive it.
  markOffline(token) { const session = this.sessions.get(token); if (!session) return; session.lastSeenAt = 0; session.controlEnabled = false; }
  isOnline(token) { const session = this.sessions.get(token); return Boolean(session && this.now() - session.lastSeenAt <= this.onlineWindowMs); }
  onlineTokens() { return [...this.sessions.keys()].filter((token) => this.isOnline(token)); }
  hasOnlineBrowser(token) { return Boolean(token) && this.isOnline(token); }
  controlEnabled(token) { return this.hasOnlineBrowser(token) && this.#session(token).controlEnabled === true; }
  hasActivePollingWaiter(token) { return Boolean(token && this.#session(token).pollWaiters.length); }
  transportStatus(token) { const session = token ? this.sessions.get(token) : null; return { lastLeaseAgeMs: session?.lastSeenAt ? Math.max(0, this.now() - session.lastSeenAt) : null, extensionVersion: session?.extensionVersion || null, runnerDiagnostic: session?.runnerDiagnostic || null, degraded: session?.transportDegraded === true, failureReason: session?.transportFailureReason || null }; }
  markTransportDegraded(token, reason = 'A command was delivered but was not confirmed before its timeout.') { const session = this.#session(token); session.transportDegraded = true; session.transportFailureReason = reason; }
  markTransportRecovered(token) { const session = this.#session(token); session.transportDegraded = false; session.transportFailureReason = null; }
  enqueue(token, command, timeoutMs = MAX_COMMAND_TIMEOUT_MS) {
    this.#expire();
    if (command?.type === 'screenshot') {
      for (const r of this.#records(token)) {
        if (r.command?.type === 'screenshot' && r.state === 'queued') {
          r.state = 'cancelled';
          r.updatedAt = new Date(this.now()).toISOString();
        }
      }
    }
    const sequence = (this.state.sequenceByBrowser[token] || 0) + 1; this.state.sequenceByBrowser[token] = sequence; const record = { id: command.id, browserId: token, seq: sequence, command, state: 'queued', createdAt: command.createdAt, updatedAt: new Date(this.now()).toISOString(), expiresAt: this.now() + boundedTimeout(timeoutMs, MAX_COMMAND_TIMEOUT_MS) }; this.state.records.push(record); this.#save(); const waiter = this.#session(token).pollWaiters.shift(); if (waiter) waiter(this.#deliver(record)); return record; }
  cancelPendingForBrowser(token) {
    const summary = { cancelled: 0, revokedInFlight: 0 };
    for (const record of this.#records(token)) {
      if (!['queued', 'delivered', 'received'].includes(record.state)) continue;
      const inFlight = record.state === 'received';
      record.state = inFlight ? 'revoked_in_flight' : 'cancelled';
      record.updatedAt = new Date(this.now()).toISOString();
      const session = this.#session(token);
      const waiter = session.resultWaiters.get(record.id);
      if (waiter) {
        session.resultWaiters.delete(record.id);
        waiter(inFlight
          ? { ok: false, code: 'revoked_in_flight', error: 'Browser access was revoked after the command was received; it may have run.' }
          : { ok: false, code: 'browser_revoked', error: 'Browser access was revoked.' });
      }
      if (inFlight) summary.revokedInFlight += 1;
      else summary.cancelled += 1;
    }
    if (summary.cancelled || summary.revokedInFlight) this.#save();
    return summary;
  }
  cancelPendingForAgent(agentId) {
    let count = 0;
    const result = { ok: false, error: 'This agent was disconnected, so the command was cancelled.', code: 'agent_revoked' };
    for (const record of this.state.records) {
      // A received command has already started in the browser and cannot be recalled.
      if (record.command?.agentId !== agentId || !['queued', 'delivered'].includes(record.state)) continue;
      record.state = 'cancelled';
      record.updatedAt = new Date(this.now()).toISOString();
      const session = this.#session(record.browserId);
      const waiter = session.resultWaiters.get(record.id);
      if (waiter) { session.resultWaiters.delete(record.id); waiter(result); }
      count += 1;
    }
    if (count) this.#save();
    return count;
  }
  #deliver(record) { if (record.state === 'queued') { record.state = 'delivered'; record.updatedAt = new Date(this.now()).toISOString(); this.#save(); } return { seq: record.seq, command: record.command }; }
  nextForBrowser(token, lastReceivedSeq = 0, lastCompletedSeq = 0) { if (!this.markOnline(token)) return null; this.#expire(); const record = this.#records(token).sort((a, b) => a.seq - b.seq).find((entry) => ['queued', 'delivered', 'received'].includes(entry.state) && entry.seq > Math.min(Number(lastCompletedSeq) || 0, Number(lastReceivedSeq) || 0)); return record ? this.#deliver(record) : null; }
  poll(token, waitMs = DEFAULT_POLL_WAIT_MS, controlEnabled, extensionVersion, runnerDiagnostic) { if (!this.markOnline(token, controlEnabled, extensionVersion, runnerDiagnostic)) return Promise.resolve(null); this.markTransportRecovered(token); const next = this.nextForBrowser(token, 0, 0); if (next) return Promise.resolve(next.command); const session = this.#session(token); return new Promise((resolve) => { const settle = (delivery) => { clearTimeout(timer); resolve(delivery?.command || null); }; const timer = setTimeout(() => { session.pollWaiters = session.pollWaiters.filter((item) => item !== settle); resolve(null); }, waitMs); session.pollWaiters.push(settle); }); }
  submitResult(token, id, result) { this.#expire(); const record = this.state.records.find((entry) => entry.browserId === token && entry.id === id); if (!record || record.state === 'expired' || record.state === 'revoked_in_flight' || (record.state === 'cancelled' && record.command?.type !== 'screenshot')) return false; if (!['completed', 'failed'].includes(record.state)) { record.state = result.ok ? 'completed' : 'failed'; record.result = result; record.updatedAt = new Date(this.now()).toISOString(); this.#save(); this.markTransportRecovered(token); const waiter = this.#session(token).resultWaiters.get(id); if (waiter) { this.#session(token).resultWaiters.delete(id); waiter(result); } } return true; }
  waitForResult(token, id, timeoutMs) { const session = this.#session(token); return new Promise((resolve) => { const timer = setTimeout(() => { session.resultWaiters.delete(id); const record = this.record(id); if (record && ['queued', 'delivered', 'received'].includes(record.state)) { record.state = 'expired'; record.updatedAt = new Date(this.now()).toISOString(); this.#save(); this.markTransportDegraded(token); } resolve(null); }, timeoutMs); session.resultWaiters.set(id, (result) => { clearTimeout(timer); resolve(result); }); }); }
  record(id) { return this.state.records.find((record) => record.id === id) || null; }
}
