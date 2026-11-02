import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from './tools.js';
import { AGENT_CAPABILITIES, canUseTool, hasCapability, normalizeCapabilities, visibleTools } from './agent-capabilities.js';
import { AgentTokenStore } from './agent-token-store.js';
import { createRunGrants, scopeRunBrowserArgs, visibleRunBrowsers } from './run-grants.js';
import { ApproverStore } from './approver-store.js';
import { BrowserCommandQueue, buildCommand, boundedTimeout } from './command-queue.js';
import { TOOL_MINIMUMS, COMMAND_MINIMUMS, PER_TAB_READ_MINIMUM, FRAME_TARGET_MINIMUM, APPROVAL_MINIMUM, LOCATOR_MINIMUMS, MINIMUM_EXTENSION_VERSION, isOlderExtension, outdatedExtension } from './extension-minimums.js';
import { SeenPages } from './seen-pages.js';
// Tools executed by enqueueing a command in the paired browser. Tab tools were
// added 2026-10-22 so agents can read, control, and switch between any tab.
// Result codes a browser may report back. Anything else from the browser is
// reported as browser_denied, so a browser cannot impersonate broker-side codes.
const BROWSER_RESULT_CODES = new Set(['look_first', 'tab_changed', 'tab_not_found', 'tab_invalid', 'screenshot_unavailable', 'ambiguous_target']);
const LOOK_FIRST_TOOLS = new Set(['edge_click', 'edge_press', 'edge_type', 'edge_select']);
const SNAPSHOT_READ_TOOLS = new Set(['edge_snapshot', 'edge_extract_text', 'edge_active_tab', 'edge_find_elements']);
const BROWSER_COMMAND_TOOLS = ['edge_click', 'edge_press', 'edge_type', 'edge_scroll', 'edge_select', 'edge_navigate', 'edge_wait', 'edge_list_open_tabs', 'edge_read_tab', 'edge_open_tab', 'edge_activate_tab', 'edge_close_tab'];
import { VerifiedActionRegistry } from './verified-action-registry.js';
import { ReceiptStore } from './receipt-store.js';
import { TransactionStore } from './transaction-store.js';
import { canonicalActor, sha256 } from './verified-action.js';
import { BrowserHandoffLease } from './browser-handoff-lease.js';
import { BrowserRegistry, registryPaths } from './browser-registry.js';
import { AgentControlLease, idleMsFromEnv } from './agent-control-lease.js';
import { createHmacHandoffControllerAuthenticator } from './handoff-controller-auth.js';
import { OAuthProvider } from './oauth.js';
import { OwnerSessions } from './owner-session.js';
import { EventLog, summarize } from './event-log.js';
import { createCloudReceived, readReview } from './cloud-received.js';
import { PasskeyStore } from './passkey-store.js';
import { verifyAssertion, verifyRegistration } from './webauthn.js';
import { clientIp } from './client-ip.js';
import { expectsJsonRpcResponse, isJsonRpcMessage, negotiatedProtocolVersion, readRequestBody, redirect, sendEmpty, sendHtml, sendJson } from './mcp-http.js';
import { ensureFirstBoot } from './first-boot.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const policyExample = resolve(root, 'config/policy.example.json');
const SERVER_VERSION = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const DEFAULT_TOKEN_STORE = '/etc/work-edge/browser-tokens.json';
const PAIR_CODE_TTL_MS = 5 * 60_000;
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIN_SUPPORTED_EXTENSION_VERSION = '1.0.0';
const MIN_SCREENSHOT_EXTENSION_VERSION = '0.3.0';
const MAX_SCREENSHOT_DATA_URL_BYTES = 5 * 1024 * 1024;
const REFUSAL_COOLDOWN_MS = 10_000;
const lastRefusalAt = new Map();
class BrowserInspectionError extends Error {}

export function statePaths(env = process.env) {
  const dataDir = resolve(env.FBB_DATA_DIR || '/data');
  return {
    secrets: join(dataDir, 'secrets.json'),
    browserTokens: env.WORK_EDGE_TOKEN_STORE || join(dataDir, 'browser-tokens.json'),
    agentTokens: env.WORK_EDGE_AGENT_TOKEN_STORE || join(dataDir, 'agent-tokens.json'),
    browserRegistry: env.WORK_EDGE_BROWSER_REGISTRY || join(dataDir, 'browser-registry.json'),
    browserSelection: env.WORK_EDGE_BROWSER_SELECTION || join(dataDir, 'browser-selection.json'),
    commandState: env.WORK_EDGE_COMMAND_STATE || join(dataDir, 'command-state.json'),
    oauthState: env.FBB_OAUTH_STATE || join(dataDir, 'oauth.json'),
    receipts: env.WORK_EDGE_RECEIPT_STORE || join(dataDir, 'verified-action-receipts.json'),
    cloudReceived: env.FBB_CLOUD_RECEIVED_DIR || join(dataDir, 'cloud-received'),
    transactions: env.WORK_EDGE_TRANSACTION_STORE || join(dataDir, 'verified-action-transactions.json'),
    transactionKey: env.WORK_EDGE_TRANSACTION_KEY || join(dataDir, 'verified-action-transactions.key'),
    passkeys: env.FBB_PASSKEY_STORE || join(dataDir, 'passkeys.json'),
    approvers: env.FBB_APPROVER_STORE || join(dataDir, 'approvers.json')
  };
}

function publicBaseUrlFor(env) {
  const configured = typeof env.PUBLIC_BASE_URL === 'string' ? env.PUBLIC_BASE_URL.trim() : '';
  if (!configured && (env.NODE_ENV === 'production' || env.FBB_IN_CONTAINER === '1')) throw new Error('PUBLIC_BASE_URL is required in production mode.');
  return (configured || 'http://127.0.0.1:8767').replace(/\/$/, '');
}

function transactionKeyFromEnv(env) {
  if (!env.FBB_TRANSACTION_SECRET) return undefined;
  const key = Buffer.from(env.FBB_TRANSACTION_SECRET, 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.FBB_TRANSACTION_SECRET) throw new Error('FBB_TRANSACTION_SECRET must be a base64-encoded 32-byte key.');
  return key;
}

export function prepareStartupEnv(env = process.env) {
  if (env.FBB_IN_CONTAINER === '1' || env.FBB_DATA_DIR) ensureFirstBoot({ env });
  return env;
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isVersionAtLeast(value, minimumValue) {
  const current = parseVersion(value);
  const minimum = parseVersion(minimumValue);
  if (!current || !minimum) return false;
  for (let i = 0; i < 3; i++) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}

function isSupportedExtensionVersion(value) { return isVersionAtLeast(value, MIN_SUPPORTED_EXTENSION_VERSION); }

function extensionPackage(directory) {
  let names;
  try { names = readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = names.map((filename) => ({ filename, version: filename.match(/^field-browser-bridge-(\d+\.\d+\.\d+)\.zip$/u)?.[1] }))
    .filter(({ version }) => version && parseVersion(version));
  candidates.sort((a, b) => {
    const left = parseVersion(a.version), right = parseVersion(b.version);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
    return 0;
  });
  for (const { filename, version } of candidates) {
    const path = join(directory, filename);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isFile()) return { path, filename, version, bytes: stat.size };
  }
  return null;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Work Edge policy must be an object.');
  const { host, port } = policy.listen || {};
  const hostname = typeof host === 'string' && host.endsWith('.') ? host.slice(0, -1) : host;
  const validHostname = typeof hostname === 'string' && hostname.length <= 253 && hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (typeof host !== 'string' || !host.trim() || host !== host.trim() || (!isIP(host) && !validHostname)) throw new Error('Work Edge policy listen.host must be a non-empty host name or IP address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Work Edge policy listen.port must be an integer from 0 to 65535.');
  if (!Array.isArray(policy.allowOrigins) || !Array.isArray(policy.denyUrlPrefixes) || !policy.capture) throw new Error('Work Edge policy is missing required fields.');
  if (!policy.allowOrigins.every((origin) => typeof origin === 'string' && origin.trim() === origin && (origin === '*' || (() => { try { return new URL(origin).origin === origin; } catch { return false; } })()))) throw new Error("Work Edge policy allowOrigins entries must be '*' or exact URL origins.");
  if (!policy.denyUrlPrefixes.every((prefix) => typeof prefix === 'string')) throw new Error('Work Edge policy denyUrlPrefixes entries must be strings.');
  return policy;
}

export function loadPolicy(env = process.env) {
  const configured = env.WORK_EDGE_POLICY;
  const local = resolve(root, 'config/policy.local.json');
  const source = configured || (existsSync(local) ? local : policyExample);
  let policy;
  try { policy = JSON.parse(readFileSync(source, 'utf8')); } catch (error) { throw new Error(`Unable to load Work Edge policy from ${source}: ${error.message}`); }
  const listen = {
    host: env.FBB_LISTEN_HOST || (env.FBB_IN_CONTAINER === '1' ? '0.0.0.0' : policy.listen?.host),
    port: env.FBB_LISTEN_PORT === undefined ? policy.listen?.port : Number(env.FBB_LISTEN_PORT)
  };
  return { ...validatePolicy({ ...policy, listen }), source };
}

export function displayUrl(url, policy) { const parsed = new URL(url); return policy.audit?.includeUrlPath ? parsed.toString() : parsed.origin; }
// `allowOrigins: ['*']` releases the origin allowlist. An empty list allows no
// origins; otherwise entries are exact URL origins. Deny prefixes always win.
export function allowedUrl(url, policy) { if (typeof url !== 'string') return false; try { const parsed = new URL(url); const originAllowed = policy.allowOrigins.includes('*') || policy.allowOrigins.includes(parsed.origin); return originAllowed && !policy.denyUrlPrefixes.some((prefix) => url.startsWith(prefix)); } catch { return false; } }
function cleanElements(elements) { if (!Array.isArray(elements)) return []; return elements.slice(0, 250).flatMap((element) => { if (!element || typeof element.tag !== 'string') return []; const tag = element.tag.toLowerCase(); if (!/^[a-z][a-z0-9-]*$/.test(tag)) return []; const ref = typeof element.ref === 'string' && /^(?:work-edge-[a-z0-9-]+|fbb-frame:[1-9]\d*::work-edge-[a-z0-9-]+)$/.test(element.ref) && element.ref.length <= 200 ? element.ref : undefined; const frameId = Number.isSafeInteger(element.frameId) && element.frameId >= 0 ? element.frameId : undefined; const role = typeof element.role === 'string' ? element.role.toLowerCase() : ''; const type = typeof element.type === 'string' ? element.type.toLowerCase() : ''; return [{ tag, text: (typeof element.text === 'string' && element.text ? element.text : typeof element.name === 'string' ? element.name : '').slice(0, 200), ...(/^[a-z]{1,30}$/.test(role) ? { role } : {}), ...(typeof element.type === 'string' && ['', 'text', 'search', 'email', 'url', 'tel', 'number'].includes(type) ? { type } : {}), ...(typeof element.hasValue === 'boolean' ? { hasValue: element.hasValue } : {}), ...(frameId !== undefined ? { frameId } : {}), ...(ref ? { ref } : {}) }]; }); }
function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 40).flatMap((row) => {
    if (!row || typeof row.ref !== 'string' || !/^(?:work-edge-[a-z0-9-]+|fbb-frame:[1-9]\d*::work-edge-[a-z0-9-]+)$/.test(row.ref) || row.ref.length > 200) return [];
    return [{ ref: row.ref, text: String(row.text || '').replace(/\s+/gu, ' ').trim().slice(0, 300), unread: row.unread === true }];
  });
}

export function normalizeCapture(input, policy, now = new Date()) {
  const approvedReadOnlyWatch = input?.userInitiated === false && input?.readOnlyWatch === true;
  if (!input || (input.userInitiated !== true && !approvedReadOnlyWatch)) throw new Error('Capture must be explicitly user initiated or approved read-only watch.');
  if (!allowedUrl(input.url, policy)) throw new Error('Capture denied by URL policy.');
  const capturedAt = new Date(input.capturedAt || now);
  if (Number.isNaN(capturedAt.valueOf()) || Math.abs(now - capturedAt) > 5 * 60_000) throw new Error('Capture timestamp is outside the allowed window.');
  if (!Number.isInteger(input.tabId)) throw new Error('Capture tab identity is incomplete.');
  if (typeof input.text !== 'string') throw new Error('Capture text is invalid.');
  if (input.text.length > policy.capture.maxTextCharacters) throw new Error('Capture text exceeds the configured limit.');
  // Whitelist fields: cookies, storage, form values, and arbitrary connector metadata are never retained.
  return Object.freeze({
    tabId: input.tabId,
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    url: input.url,
    text: input.text,
    ...(input.swapReview && Number.isSafeInteger(input.swapReview.count) && input.swapReview.count >= 0
      ? { swapReview: { count: input.swapReview.count, textLength: Number.isSafeInteger(input.swapReview.textLength) ? input.swapReview.textLength : input.text.length,
        counts: Object.fromEntries(Object.entries(input.swapReview.counts || {}).filter(([key, value]) => /^\[(?:CLIENT|PERSON|PHONE|EMAIL|ADDRESS|ID|DATE)-\d+\]$/u.test(key) && Number.isSafeInteger(value) && value > 0).slice(0, 100)) } } : {}),
    text_total_chars: Number.isInteger(input.text_total_chars) && input.text_total_chars >= input.text.length ? input.text_total_chars : input.text.length,
    truncated: input.truncated === true,
    elementSummary: cleanElements(input.elementSummary),
    rows: input.sensitiveReadRestricted === true && !input.text ? [] : cleanRows(input.rows),
    capturedAt: capturedAt.toISOString(),
    userInitiated: input.userInitiated === true,
    readOnlyWatch: approvedReadOnlyWatch,
    approvedOriginCount: Number.isInteger(input.approvedOriginCount) && input.approvedOriginCount >= 0 && input.approvedOriginCount <= 10_000 ? input.approvedOriginCount : 0,
    approvedSensitiveOriginCount: Number.isInteger(input.approvedSensitiveOriginCount) && input.approvedSensitiveOriginCount >= 0 && input.approvedSensitiveOriginCount <= 10_000 ? input.approvedSensitiveOriginCount : 0,
    sensitiveReadRestricted: input.sensitiveReadRestricted === true,
    sensitiveReadPersistent: input.sensitiveReadPersistent === true,
    screenshotRef: null
  });
}

// Since 2026-10-22 captures are also kept per tab, so an agent working several
// tabs reads the tab it asked about, never whichever tab loaded last.
const MAX_TABS_PER_BROWSER = 50;
class CaptureStore {
  constructor({ now = () => Date.now() } = {}) { this.captures = new Map(); this.byTab = new Map(); this.screenshots = new Map(); this.now = now; }
  put(browserId, capture) {
    this.captures.set(browserId, capture);
    if (!Number.isInteger(capture?.tabId)) return;
    let tabs = this.byTab.get(browserId);
    if (!tabs) { tabs = new Map(); this.byTab.set(browserId, tabs); }
    tabs.delete(capture.tabId);
    tabs.set(capture.tabId, capture);
    while (tabs.size > MAX_TABS_PER_BROWSER) tabs.delete(tabs.keys().next().value);
  }
  latest(browserId, tabId) {
    if (tabId !== undefined) return this.byTab.get(browserId)?.get(tabId) || null;
    return this.captures.get(browserId) || null;
  }
  capturedTabs(browserId) { return [...(this.byTab.get(browserId)?.values() || [])].reverse(); }
  putScreenshot(browserId, screenshot) { this.screenshots.set(browserId, screenshot); }
  takeScreenshot(browserId, commandId) {
    const screenshot = this.screenshots.get(browserId);
    if (!screenshot || screenshot.commandId !== commandId) return null;
    this.screenshots.delete(browserId);
    return screenshot;
  }
  status(browserId) {
    const capture = this.latest(browserId);
    if (!capture) return { connector: 'waiting_for_capture', capture: 'unavailable', watchMode: 'waiting_for_trusted_origin' };
    return {
      connector: 'connected', capture: 'available', capturedAt: capture.capturedAt,
      watchMode: capture.readOnlyWatch ? 'active' : 'available_after_trusted_origin',
      approvedOriginCount: capture.approvedOriginCount,
      approvedSensitiveOriginCount: capture.approvedSensitiveOriginCount,
      sensitiveReadRestricted: capture.sensitiveReadRestricted,
      sensitiveReadPersistent: capture.sensitiveReadPersistent,
      lastCaptureAgeMs: Math.max(0, this.now() - new Date(capture.capturedAt).valueOf())
    };
  }
}
class AuditLogger {
  constructor(policy, write = (line) => process.stdout.write(line), sink = () => {}) { this.policy = policy; this.output = write; this.sink = sink; }
  write({ event = 'work_edge_tool_call', tool, outcome, snapshot, agentId, browserId, commandId, target, source, cancelled, revokedInFlight, approver }) {
    const entry = {
      event,
      timestamp: new Date().toISOString(),
      agentId: typeof agentId === 'string' ? agentId : null,
      browserId: /^brw_[a-f0-9]{16}$/.test(String(browserId || '')) ? browserId : null,
      commandId: typeof commandId === 'string' && commandId ? commandId : null,
      tool,
      outcome,
      ...(source ? { source } : {}),
      ...(typeof tool === 'string' && (tool.startsWith('owner_') || tool === 'approval_decision') ? { target: typeof target === 'string' && target ? target : null } : {}),
      ...(tool === 'approval_decision' && typeof approver === 'string' ? { approver } : {}),
      ...(Number.isSafeInteger(cancelled) && cancelled >= 0 ? { cancelled } : {}),
      ...(Number.isSafeInteger(revokedInFlight) && revokedInFlight >= 0 ? { revokedInFlight } : {}),
      ...(snapshot?.url ? { url: displayUrl(snapshot.url, this.policy) } : {})
    };
    this.sink(entry);
    if (this.policy.audit?.enabled !== false) this.output(`${JSON.stringify(entry)}\n`);
  }
}
function tokenMatches(supplied, expected) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(left, right);
}
function bearerToken(req) { return req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]; }
function bearerMatches(req, token) { return tokenMatches(bearerToken(req), token); }
function textResult(value, isError = false, meta) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}), ...(meta ? { _meta: meta } : {}) }; }

function publicVerifiedAction(snapshot) {
  if (!snapshot) return null;
  const proposal = structuredClone(snapshot.proposal);
  if (proposal?.target) {
    delete proposal.target.browserId;
    delete proposal.target.tabId;
  }
  return {
    phase: snapshot.phase,
    proposal,
    proposalHash: snapshot.proposalHash,
    approval: snapshot.approval,
    rejection: snapshot.rejection,
    recovery: snapshot.recovery,
    verification: snapshot.receipt?.verification,
    receiptHash: snapshot.receipt?.receiptHash
  };
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function principalOwnsTransaction(principal, snapshot) {
  return principal?.source === 'owner-bootstrap'
    || principal?.source === 'loopback-owner-bootstrap'
    || snapshot?.proposal?.actor?.agentId === principal?.id;
}

function principalCanReadTransaction(principal, snapshot) {
  return hasCapability(principal, 'browser.audit.read') || principalOwnsTransaction(principal, snapshot);
}

function principalOwnsReceipt(principal, receipt) {
  if (hasCapability(principal, 'browser.audit.read')) return true;
  try {
    return receipt?.approvedProposalEvidence?.actorHash === sha256(canonicalActor({ agentId: principal?.id }));
  } catch {
    return false;
  }
}

function verifiedLocator(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} locator is required`);
  const entries = ['ref', 'selector', 'targetText'].filter((key) => typeof value[key] === 'string' && value[key].trim());
  if (entries.length !== 1) throw new TypeError(`${name} locator must provide exactly one of ref, selector, or targetText`);
  const key = entries[0];
  const limit = key === 'selector' ? 512 : 200;
  if (value[key].length > limit) throw new TypeError(`${name} locator exceeds its limit`);
  return { [key]: value[key].trim() };
}

function verifiedSteps(changes) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw new TypeError('changes must contain 1 to 100 fields');
  const steps = changes.map((change, index) => {
    if (!change || typeof change !== 'object' || !['type', 'select'].includes(change.control)) throw new TypeError(`changes[${index}].control is invalid`);
    if (typeof change.field !== 'string' || !change.field.trim() || change.field.length > 200) throw new TypeError(`changes[${index}].field is invalid`);
    if (typeof change.to !== 'string') throw new TypeError(`changes[${index}].to is invalid`);
    if (change.to.length > 4000) throw new TypeError(`changes[${index}].to exceeds its limit`);
    return { field: change.field.trim(), to: change.to, control: change.control, locator: verifiedLocator(change.locator, `changes[${index}]`) };
  });
  if (new Set(steps.map((step) => step.field)).size !== steps.length) throw new TypeError('changes cannot contain duplicate fields');
  return steps;
}

function tokenDigest(token) { return createHash('sha256').update(token).digest('hex'); }
export function approvalActorLabel(principal, supplied) {
  return hasCapability(principal, 'manage_browser_privacy') && typeof supplied === 'string'
    && supplied.length <= 60 && /^[\p{L}\p{N} .()-]+$/u.test(supplied) ? supplied : null;
}
function tokenStoreData(value) { return value && typeof value === 'object' && Array.isArray(value.tokenHashes) ? value : { version: 1, tokenHashes: [] }; }

// Only token verifiers are persisted. The browser is the sole holder of the bearer
// secret after exchange; this file is deliberately mode 0600 when it is created.
export class PairedTokenStore {
  constructor({ filePath = process.env.WORK_EDGE_TOKEN_STORE || DEFAULT_TOKEN_STORE } = {}) { this.filePath = filePath; }
  read() {
    if (!existsSync(this.filePath)) return { version: 1, tokenHashes: [] };
    try { return tokenStoreData(JSON.parse(readFileSync(this.filePath, 'utf8'))); } catch { throw new Error('Paired browser token store is unreadable.'); }
  }
  add(token) {
    const data = this.read();
    const hash = tokenDigest(token);
    if (!data.tokenHashes.includes(hash)) data.tokenHashes.push(hash);
    this.write(data);
  }
  revoke(digest) {
    if (!/^[a-f0-9]{64}$/.test(String(digest || ''))) throw new TypeError('browser digest is invalid');
    const data = this.read();
    if (!data.tokenHashes.includes(digest)) return false;
    data.tokenHashes = data.tokenHashes.filter((hash) => hash !== digest);
    this.write(data);
    return true;
  }
  write(data) {
    const directory = resolve(this.filePath, '..');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, tokenHashes: data.tokenHashes }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
  matches(token) { return Boolean(token) && this.read().tokenHashes.some((hash) => tokenMatches(tokenDigest(token), hash)); }
}

function newPairCode() { return Array.from({ length: 12 }, () => PAIR_CODE_ALPHABET[randomBytes(1)[0] % PAIR_CODE_ALPHABET.length]).join(''); }
export class PairingService {
  constructor({ tokenStore = new PairedTokenStore(), now = () => Date.now(), ttlMs = PAIR_CODE_TTL_MS } = {}) { this.tokenStore = tokenStore; this.now = now; this.ttlMs = ttlMs; this.sessions = new Map(); }
  removeExpired() { for (const [code, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(code); }
  create({ replacesBrowserId } = {}) { this.removeExpired(); let code; do { code = newPairCode(); } while (this.sessions.has(code)); const expiresAt = this.now() + this.ttlMs; this.sessions.set(code, { expiresAt, replacesBrowserId }); return { code, expiresAt: new Date(expiresAt).toISOString() }; }
  exchange(code) {
    this.removeExpired();
    if (typeof code !== 'string' || !/^[A-Z2-9]{12}$/.test(code)) return null;
    const session = this.sessions.get(code);
    if (!session || session.expiresAt <= this.now()) return null;
    this.sessions.delete(code); // single use, including if persistence subsequently fails
    const token = randomBytes(32).toString('base64url');
    this.tokenStore.add(token);
    return { token, pairedAt: new Date(this.now()).toISOString(), ...(session.replacesBrowserId ? { replacesBrowserId: session.replacesBrowserId } : {}) };
  }
}

export function resultFor(name, args, { policy, store, commandQueue, browserDigest, commandTransport = {}, browsers = [], agentControl = { holder: null, expiresAt: null }, stale = false }) {
  if (['edge_click', 'edge_type', 'edge_navigate'].includes(name)) return textResult('Approval required: this action tool is intentionally not implemented.', true, { approvalRequired: true });
  if (name === 'edge_status') return textResult(store.status(browserDigest));
  if (name === 'edge_bridge_status') return textResult({
    bridge: 'work_browser_bridge',
    transport: 'paired_browser_outbound_wss_primary_https_recovery',
    recentCommandPolling: commandTransport.pollingActive === true,
    websocketLiveOrRecent: commandTransport.healthy === true,
    commandTransport: {
      healthy: commandTransport.healthy === true,
      websocketLive: commandTransport.websocketLive === true,
      activePolling: commandTransport.pollingActive === true,
      diagnostic: commandTransport.runnerDiagnostic || (commandTransport.websocketLive ? 'websocket_active' : commandTransport.pollingActive ? 'polling_recovery_active' : 'no_viable_command_transport'),
      lastCommandLeaseAgeMs: commandTransport.lastLeaseAgeMs,
      extensionVersion: commandTransport.extensionVersion,
      degraded: commandTransport.degraded === true,
      failureReason: commandTransport.failureReason || null
    },
    watch: {
      readOnlyCaptureDoesNotRequireArm: true,
      approvedOriginsOnly: true,
      sensitiveReadPersistent: store.status(browserDigest).sensitiveReadPersistent,
      approvedSensitiveOriginCount: store.status(browserDigest).approvedSensitiveOriginCount,
      capture: store.status(browserDigest)
    },
    control: {
      browserControlIsToggle: true,
      enabled: Boolean(browserDigest && commandQueue?.controlEnabled(browserDigest)),
      explicitApprovalRequiredForFinalActions: true,
      note: 'Enabled reflects the last state reported by the currently connected paired browser; browser-side enforcement remains authoritative.'
    },
    agentControl,
    capture: store.status(browserDigest),
    browsers
  });
  const snapshot = store.latest(browserDigest, args?.tabId);
  if (!snapshot) return textResult(args?.tabId !== undefined ? `No snapshot of tab ${args.tabId} yet. Use edge_read_tab to read it.` : 'No explicit active-tab capture is available.', true);
  if (!allowedUrl(snapshot.url, policy)) return textResult('Capture denied by URL policy.', true);
  const boundedText = snapshot.text.slice(0, Math.min(args?.maxCharacters || policy.capture.maxTextCharacters, policy.capture.maxTextCharacters));
  const freshness = { capturedAt: snapshot.capturedAt, ageMs: Math.max(0, store.now() - Date.parse(snapshot.capturedAt)), ...(stale ? { stale: true } : {}) };
  const metadata = { id: snapshot.tabId, title: snapshot.title, url: displayUrl(snapshot.url, policy), ...freshness };
  const matches = name === 'edge_find_elements' ? snapshot.elementSummary.filter((element) => typeof args.selector === 'string' && (args.selector === '*' || element.tag === args.selector.toLowerCase())).slice(0, 50) : undefined;
  const capturedTabs = store.capturedTabs(browserDigest).filter((capture) => allowedUrl(capture.url, policy)).map((capture) => ({ id: capture.tabId, title: capture.title, url: displayUrl(capture.url, policy), capturedAt: capture.capturedAt, ageMs: Math.max(0, store.now() - Date.parse(capture.capturedAt)), ...(stale ? { stale: true } : {}) }));
  const textMetadata = { text_total_chars: snapshot.text_total_chars ?? snapshot.text.length, truncated: snapshot.truncated === true || boundedText.length < snapshot.text.length };
  const fields = (snapshot.elementSummary || []).filter((element) => element.ref && (['input', 'textarea', 'select'].includes(element.tag) || ['textbox', 'searchbox', 'combobox'].includes(element.role))).slice(0, 40).map((element) => ({ ref: element.ref, tag: element.tag, type: element.type || '', role: element.role || '', name: element.text, hasValue: element.hasValue === true }));
  return textResult({ edge_list_tabs: capturedTabs.length ? capturedTabs : [metadata], edge_active_tab: metadata, edge_snapshot: { ...metadata, text: boundedText, ...textMetadata, fields, rows: snapshot.rows || [], ...(snapshot.swapReview ? { swapReview: snapshot.swapReview } : {}) }, edge_screenshot: { available: false, ref: null }, edge_extract_text: { text: boundedText, ...textMetadata, ...freshness, ...(snapshot.swapReview ? { swapReview: snapshot.swapReview } : {}) }, edge_find_elements: { selector: args.selector, matches, note: 'Matches are from the explicit capture summary only.' } }[name]);
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
async function jsonBody(req, maxBytes = 1_000_000) { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > maxBytes) throw new Error('Request body too large.'); } return JSON.parse(body); }
function normalizeScreenshot(input, policy, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Screenshot is invalid.');
  if (!allowedUrl(input.url, policy)) throw new Error('Screenshot denied by URL policy.');
  if (!Number.isInteger(input.tabId)) throw new Error('Screenshot tab identity is incomplete.');
  if (typeof input.commandId !== 'string' || !/^[a-f0-9]{16}$/.test(input.commandId)) throw new Error('Screenshot command identity is invalid.');
  const capturedAt = new Date(input.capturedAt || now);
  if (Number.isNaN(capturedAt.valueOf()) || Math.abs(now - capturedAt) > 5 * 60_000) throw new Error('Screenshot timestamp is outside the allowed window.');
  if (input.mimeType !== 'image/png' || typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith('data:image/png;base64,') || Buffer.byteLength(input.dataUrl) > MAX_SCREENSHOT_DATA_URL_BYTES) throw new Error('Screenshot must be a PNG data URL no larger than 5 MB.');
  const data = input.dataUrl.slice('data:image/png;base64,'.length);
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Screenshot PNG data is invalid.');
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length < 8 || !decoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('Screenshot data is not a PNG image.');
  return Object.freeze({ commandId: input.commandId, tabId: input.tabId, url: input.url, capturedAt: capturedAt.toISOString(), data });
}
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); }
function websocketAccept(key) { return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); }
function websocketSend(socket, message) {
  try {
    if (socket.destroyed || socket.writableEnded) return false;
    const data = Buffer.from(JSON.stringify(message));
    if (data.length > 2_000_000) return false;
    let header;
    if (data.length < 126) header = Buffer.from([0x81, data.length]);
    else if (data.length <= 0xffff) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    socket.write(Buffer.concat([header, data]));
    return true;
  } catch { return false; }
}
function websocketClose(socket, payload = Buffer.alloc(0)) {
  if (socket.destroyed || socket.writableEnded) return;
  const body = payload.subarray(0, 125);
  socket.end(Buffer.concat([Buffer.from([0x88, body.length]), body]));
}
function websocketMessages(socket, receive, close) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = Boolean(pending[1] & 0x80); let length = pending[1] & 0x7f; let offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (pending.length < 10) return;
        const wideLength = pending.readBigUInt64BE(2);
        if (wideLength > 2_000_000n) { socket.destroy(); return; }
        length = Number(wideLength); offset = 10;
      }
      if (!masked) { socket.destroy(); return; }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4); const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 0x08) { close(payload); return; }
      if (opcode === 0x0a) { socket.isAlive = true; continue; }
      if (opcode === 0x09) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      try { receive(JSON.parse(payload.toString('utf8'))); } catch { socket.destroy(); return; }
    }
  });
}

export function createServer({ policy = loadPolicy(), devToken: suppliedDevToken, store = new CaptureStore(), tokenStore: suppliedTokenStore, agentTokenStore: suppliedAgentTokenStore, runGrants: suppliedRunGrants, approverStore: suppliedApproverStore, oauthProvider: suppliedOAuthProvider, ownerSessions: suppliedOwnerSessions, browserRegistry: suppliedBrowserRegistry, pairing, commandQueue: suppliedCommandQueue, receiptStore: suppliedReceiptStore, transactionStore: suppliedTransactionStore, verifiedActions: suppliedVerifiedActions, handoffLease: suppliedHandoffLease, agentControlLease: suppliedAgentControlLease, handoffControllerAuthenticator: suppliedHandoffControllerAuthenticator, passkeyStore: suppliedPasskeyStore, auditWriter, eventLog: suppliedEventLog, env = process.env, commandAckTimeoutMs = 1_500, setHeartbeatInterval = setInterval } = {}) {
  validatePolicy(policy);
  const paths = statePaths(env);
  const publicBaseUrl = publicBaseUrlFor(env);
  const devToken = suppliedDevToken === undefined ? env.WORK_EDGE_DEV_TOKEN : suppliedDevToken;
  const mcpToken = env.WORK_EDGE_MCP_TOKEN || null;
  const tokenStore = suppliedTokenStore || new PairedTokenStore({ filePath: paths.browserTokens });
  const agentTokenStore = suppliedAgentTokenStore || new AgentTokenStore({ filePath: paths.agentTokens });
  const runGrants = suppliedRunGrants || createRunGrants();
  const approverStore = suppliedApproverStore || new ApproverStore({ filePath: paths.approvers });
  const trustedProxies = String(env.FBB_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const oauth = suppliedOAuthProvider || new OAuthProvider({
    publicBaseUrl,
    passphrase: env.FBB_LOGIN_PASSPHRASE,
    stateFile: paths.oauthState,
    capabilities: env.FBB_OAUTH_CAPABILITIES,
    maxClients: Number(env.FBB_OAUTH_MAX_CLIENTS) || 50
  });
  const ownerSessions = suppliedOwnerSessions || new OwnerSessions({
    passphrase: env.FBB_OWNER_PASSPHRASE,
    loginPassphrase: env.FBB_LOGIN_PASSPHRASE
  });
  const passkeyStore = suppliedPasskeyStore || new PasskeyStore({ filePath: paths.passkeys });
  const passkeyApprovalsEnabled = env.FBB_PASSKEY_APPROVALS === '1';
  const rpId = env.FBB_RP_ID || new URL(publicBaseUrl).hostname;
  const passkeyOrigin = new URL(publicBaseUrl).origin;
  if (!/^[a-z0-9.-]+$/i.test(rpId)) throw new Error('FBB_RP_ID must be a host name.');
  const registrationChallenges = new Map();
  const approvalChallenges = new Map();
  const pairings = pairing || new PairingService({ tokenStore });
  const commandQueue = suppliedCommandQueue || new BrowserCommandQueue({ stateFile: paths.commandState });
  const browserRegistry = suppliedBrowserRegistry || new BrowserRegistry(registryPaths(env, tokenStore.filePath || paths.browserTokens));
  const eventLog = suppliedEventLog || new EventLog();
  const audit = new AuditLogger(policy, auditWriter, (entry) => {
    if (!/^brw_[a-f0-9]{16}$/.test(entry.browserId || '')) return;
    let browserDigest;
    try { browserDigest = browserRegistry.byId(entry.browserId); } catch { return; }
    if (!browserDigest) return;
    const approvalDecision = entry.tool === 'approval_decision' && ['approved', 'rejected'].includes(entry.outcome);
    eventLog.append(browserDigest, {
      agentId: entry.agentId,
      type: approvalDecision ? 'approval_decided' : 'tool_result',
      tool: entry.tool,
      summary: approvalDecision ? `${entry.outcome === 'rejected' ? 'Rejected' : 'Approved'} a verified action` : summarize({ tool: entry.tool, outcome: entry.outcome, url: entry.url }),
      ok: approvalDecision || ['ok', 'inspected', 'proposed', 'verified'].includes(entry.outcome)
    });
  });
  const receiptStore = suppliedReceiptStore || new ReceiptStore({ filePath: paths.receipts });
  const transactionStore = suppliedTransactionStore || new TransactionStore({ filePath: paths.transactions, keyFile: paths.transactionKey, key: transactionKeyFromEnv(env) });
  const verifiedActions = suppliedVerifiedActions || new VerifiedActionRegistry({ receiptStore, transactionStore });
  const approvalWaitMs = Math.max(1_000, Math.min(600_000, (Number(env.FBB_APPROVAL_WAIT_SECONDS) || 120) * 1_000));
  const pendingClicks = new Map();
  const approvalOutcomes = new Map();
  const pendingReads = new Map();
  const cloudReceived = createCloudReceived({ directory: statePaths(env).cloudReceived });
  const outcomeTimers = new Map();
  const expiryTimers = new Map();
  const clearExpiry = (id) => {
    clearTimeout(expiryTimers.get(id));
    expiryTimers.delete(id);
  };
  const clearOutcome = (id) => {
    clearTimeout(outcomeTimers.get(id));
    outcomeTimers.delete(id);
    approvalOutcomes.delete(id);
  };
  const setOutcome = (id, outcome) => {
    clearOutcome(id);
    approvalOutcomes.set(id, outcome);
    const timer = setTimeout(() => clearOutcome(id), 10 * 60_000);
    timer.unref?.();
    outcomeTimers.set(id, timer);
    while (approvalOutcomes.size > 500) clearOutcome(approvalOutcomes.keys().next().value);
  };
  const restartError = 'The bridge restarted before this action ran; nothing was clicked.';
  const failLostClick = (id, snapshot) => {
    if (snapshot.phase === 'approved') {
      verifiedActions.beginExecution(id, { browserId: snapshot.proposal.target.browserId, proposal: snapshot.proposal,
        currentBeforeHash: snapshot.proposal.beforeHash });
      verifiedActions.failExecution(id, { browserId: snapshot.proposal.target.browserId, reason: restartError });
    } else if (snapshot.phase === 'executing') {
      verifiedActions.markIndeterminate(id, { browserId: snapshot.proposal.target.browserId, reason: restartError });
    }
    setOutcome(id, { status: 'failed', error: restartError });
  };
  const expireClick = (id) => {
    const snapshot = verifiedActions.get(id);
    if (snapshot?.phase !== 'proposed') { clearExpiry(id); return; }
    const remaining = Date.parse(snapshot.proposal.target.expiresAt) - Date.now();
    if (remaining > 0) {
      clearExpiry(id);
      const timer = setTimeout(() => expireClick(id), remaining + 1);
      timer.unref?.();
      expiryTimers.set(id, timer);
      return;
    }
    clearExpiry(id);
    verifiedActions.expire(id);
    pendingClicks.delete(id);
    setOutcome(id, { status: 'expired' });
  };
  const executeApprovedClick = (id) => {
    const pending = pendingClicks.get(id);
    if (!pending) { failLostClick(id, verifiedActions.get(id)); return; }
    pendingClicks.delete(id);
    const { token, command, target, approvalToken, transaction, timeoutMs, agentId } = pending;
    const binding = { token: approvalToken, transactionId: id, name: target.name, tag: target.tag, ref: target.ref,
      fingerprint: target.fingerprint, url: target.url, title: target.title, requestedUrl: command.url || null };
    setOutcome(id, { status: 'pending', approvalId: id, expiresAt: transaction.proposal.target.expiresAt });
    void (async () => {
      try {
        verifiedActions.beginExecution(id, { browserId: token, proposal: transaction.proposal,
          currentBeforeHash: sha256({ fingerprint: target.fingerprint, name: target.name, url: target.url }) });
        // The owner's approval plus the binding check (page, name, tag, ref) is the
        // guarantee here; the agent's look-first state from proposal time is not.
        const { seenPages: _seenAtProposal, ...approvedClick } = command;
        commandQueue.enqueue(token, { ...approvedClick, tabId: target.tabId, approvalBinding: binding }, timeoutMs);
        const browserResult = await commandQueue.waitForResult(token, command.id, timeoutMs);
        if (browserResult?.result?.page) seenPages.recordPage(agentId, token, browserResult.result.page);
        if (browserResult?.ok) {
          verifiedActions.verify(id, { browserId: token, after: browserResult.result,
            persistedChanges: [{ field: 'Action', to: target.name }], method: 'browser-command-result' });
          setOutcome(id, { status: 'approved', result: browserResult.result });
        } else {
          const error = browserResult?.error || 'The browser did not confirm the click.';
          verifiedActions.failExecution(id, { browserId: token, reason: error });
          setOutcome(id, { status: 'failed', error });
        }
      } catch (error) {
        try { verifiedActions.failExecution(id, { browserId: token, reason: error.message }); } catch {}
        setOutcome(id, { status: 'failed', error: error.message });
      }
    })();
  };
  const applySingleClickDecision = (id, decision, details) => {
    if (verifiedActions.get(id)?.phase !== 'proposed') throw new Error('transaction is not awaiting approval');
    const decided = decision === 'approve' ? verifiedActions.approve(id, details) : verifiedActions.reject(id, details);
    if (decided.proposal.target.kind === 'single_click') {
      clearExpiry(id);
      if (decision === 'approve') executeApprovedClick(id);
      else { pendingClicks.delete(id); setOutcome(id, { status: 'declined' }); }
    }
    return decided;
  };
  const handoffLease = suppliedHandoffLease || new BrowserHandoffLease();
  const agentControlLease = suppliedAgentControlLease || new AgentControlLease({ idleMs: idleMsFromEnv(env) });
  const seenPages = new SeenPages();
  const authenticateHandoffController = suppliedHandoffControllerAuthenticator || createHmacHandoffControllerAuthenticator(env);
  let activeAgentIdentity = null;
  const liveSockets = new Map();
  const swapStates = new Map();
  const acceptSwap = (digest, report) => {
    swapStates.set(digest, report?.active === true && report?.rules === true
      ? { active: true, rules: true }
      : { active: false, rules: false });
  };
  const verifiedInspections = new Map();
  const deliveryAcks = new Map();
  const ackTimeout = Number.isInteger(commandAckTimeoutMs) && commandAckTimeoutMs > 0 ? commandAckTimeoutMs : 1_500;
  const clearDeliveryAck = (id) => { const pending = deliveryAcks.get(id); if (pending) clearTimeout(pending.timer); deliveryAcks.delete(id); };
  const socketUnavailable = (browserId, socket) => {
    if (!browserId) return;
    for (const [id, pending] of deliveryAcks) if (pending.socket === socket) clearDeliveryAck(id);
    if (liveSockets.get(browserId) !== socket) return;
    liveSockets.delete(browserId);
    commandQueue.markOffline(browserId);
  };
  const commandTransport = (browserId) => {
    let socket = browserId && liveSockets.get(browserId);
    if (socket && (socket.destroyed || socket.readableEnded || socket.writableEnded)) { socketUnavailable(browserId, socket); socket = null; }
    const websocketLive = Boolean(browserId && socket && commandQueue.isOnline(browserId));
    const pollingActive = commandQueue.hasActivePollingWaiter(browserId);
    const transport = commandQueue.transportStatus(browserId);
    const controlEnabled = commandQueue.controlEnabled(browserId);
    const missingCommandTransport = controlEnabled && !websocketLive && !pollingActive;
    const failureReason = transport.failureReason || (missingCommandTransport ? 'control_enabled_without_command_transport' : null);
    return {
      websocketLive,
      pollingActive,
      healthy: (websocketLive || pollingActive) && !transport.degraded,
      ...transport,
      degraded: transport.degraded || missingCommandTransport,
      failureReason
    };
  };
  const dispatchBrowserCommand = async (command, timeoutMs, browserId, agentId) => {
    const transport = commandTransport(browserId);
    if (!transport.healthy || !browserId) return { ok: false, code: 'no_online_browser', error: transport.failureReason || 'No paired browser has a usable command transport.' };
    const minimum = COMMAND_MINIMUMS[command.type];
    if (minimum && isOlderExtension(transport.extensionVersion, minimum)) {
      const browser = browserRegistry.byDigest(browserId);
      return outdatedExtension(browser, transport.extensionVersion, command.type, minimum);
    }
    try {
      commandQueue.enqueue(browserId, agentId ? { ...command, agentId } : command, timeoutMs);
      const result = await commandQueue.waitForResult(browserId, command.id, timeoutMs);
      return result || { ok: false, code: 'command_timeout', error: 'The browser did not confirm the command before its timeout.' };
    } catch {
      return { ok: false, code: 'command_store_unavailable', error: 'The browser command could not be persisted.' };
    }
  };
  // The only place a target browser is chosen. It never substitutes one browser for another.
  const resolveBrowser = (args = {}) => {
    if (args.browserId !== undefined) {
      const digest = browserRegistry.byId(args.browserId);
      if (!digest) return { ok: false, code: 'browser_unknown', message: `No paired browser has id ${String(args.browserId).slice(0, 40)}.` };
      const browser = browserRegistry.byDigest(digest);
      if (!commandQueue.isOnline(digest)) return { ok: false, code: 'browser_offline', message: `${browser.name} (${browser.id}) is offline. Choose a browser that is online, or wait for it to reconnect.`, browserId: browser.id };
      return { ok: true, digest, browser };
    }
    const digest = browserRegistry.defaultDigest();
    if (!digest) return { ok: false, code: 'no_default_browser', message: 'No default browser is set. Pass a browserId from edge_list_browsers.' };
    const browser = browserRegistry.byDigest(digest);
    if (!commandQueue.isOnline(digest)) return { ok: false, code: 'browser_offline', message: `The default browser, ${browser.name} (${browser.id}), is offline. Pass a browserId from edge_list_browsers to choose another.`, browserId: browser.id };
    return { ok: true, digest, browser };
  };
  const listBrowsers = () => browserRegistry.list().map((browser) => {
    const digest = browserRegistry.byId(browser.id);
    const transport = commandQueue.transportStatus(digest);
    const online = commandQueue.isOnline(digest);
    const swap = online ? swapStates.get(digest) : null;
    return { ...browser, online, swap: swap ? { active: swap.active, rules: swap.rules } : { active: false, rules: false }, shareDelegatedRuns: browser.private !== true || swap?.active === true, controlEnabled: commandQueue.controlEnabled(digest), extensionVersion: transport.extensionVersion, minimumExtensionVersion: MINIMUM_EXTENSION_VERSION };
  });
  const privateBrowserMessage = "This browser is private. Client-detail swapping is not active, so cloud-agent access is blocked.";
  const mayUseBrowser = (principal, browserId) => browserRegistry.byDigest(browserRegistry.byId(browserId))?.private !== true
    || listBrowsers().find((browser) => browser.id === browserId)?.swap.active === true || hasCapability(principal, 'private_browser_local');
  const visibleBrowsers = (principal) => visibleRunBrowsers(principal, listBrowsers()).filter((browser) => mayUseBrowser(principal, browser.id));
  const normalizeAutoProvisionCapabilities = () => {
    const raw = env.WORK_EDGE_AUTO_PROVISION_CAPABILITIES;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const capabilities = normalizeCapabilities(raw.split(',').map((s) => s.trim()).filter(Boolean));
    if (capabilities.includes('private_browser_local')) throw new TypeError('Auto-provision cannot include private_browser_local.');
    return capabilities;
  };
  const autoProvisionCapabilities = normalizeAutoProvisionCapabilities();
  const mcpPrincipal = (req) => {
    const token = bearerToken(req);
    if (typeof token === 'string' && token.startsWith('fbg_')) {
      if (!['/mcp', '/work-edge/mcp'].includes(new URL(req.url, publicBaseUrl).pathname)) return null;
      const grant = runGrants.authorize(token);
      if (!grant) return null;
      const issuer = agentTokenStore.list().find((agent) => agent.id === grant.issuerId && !agent.revokedAt);
      return issuer?.credentialVersion === grant.issuerVersion && issuer.capabilities.includes('delegate_runs')
        && grant.capabilities.every((capability) => issuer.capabilities.includes(capability)) ? grant : null;
    }
    if (mcpToken && tokenMatches(token, mcpToken)) {
      return { id: env.WORK_EDGE_MCP_ID || 'owner-bootstrap', capabilities: AGENT_CAPABILITIES.filter((capability) => capability !== 'private_browser_local'), source: 'owner-bootstrap' };
    }
    const stored = agentTokenStore.authenticate(token);
    if (stored) return stored;
    const oauthPrincipal = oauth.authenticate(token);
    if (oauthPrincipal) return oauthPrincipal;

    // Auto-provision (opt-in): grant a default capability set to a
    // well-formed unrecognized token, removing the manual provisioning step.
    const autoCaps = autoProvisionCapabilities;
    if (autoCaps && typeof token === 'string' && token.length >= 32) {
      const id = `auto-${sha256(token).slice(0, 10)}`;
      try {
        agentTokenStore.add(token, { id, capabilities: autoCaps });
      } catch (error) {
        if (!String(error && error.message).includes('already exists')) throw error;
      }
      const provisioned = agentTokenStore.authenticate(token);
      if (provisioned) return provisioned;
    }

    return null;
  };
  const pairedBrowserAuthorized = (req) => tokenStore.matches(bearerToken(req));
  const liveFrames = new Map();
  const liveFramesInFlight = new Map();
  const contractError = (res, status, code, message) => send(res, status, { error: { code, message } });
  const captureScreenshot = async (digest, agentId) => {
    if (browserRegistry.byDigest(digest)?.private === true) return { code: 'private_browser', message: 'Screenshots are unavailable for private browsers.' };
    const transport = commandTransport(digest);
    if (!transport.healthy || !commandQueue.isOnline(digest)) return { code: 'browser_offline', message: 'That browser is offline.' };
    if (!isVersionAtLeast(transport.extensionVersion, MIN_SCREENSHOT_EXTENSION_VERSION)) return { code: 'capability_denied', message: 'The browser extension does not support screenshots.' };
    const built = buildCommand('edge_screenshot');
    const browserResult = await dispatchBrowserCommand(built.command, boundedTimeout(undefined), digest, agentId);
    if (!browserResult.ok) return { code: 'capability_denied', message: browserResult.error || 'The browser refused screenshot capture.' };
    const screenshot = store.takeScreenshot(digest, built.command.id);
    if (!screenshot || screenshot.tabId !== browserResult.result?.tabId) return { code: 'capability_denied', message: 'The browser did not return a matching screenshot.' };
    return { image: Buffer.from(screenshot.data, 'base64'), capturedAt: screenshot.capturedAt };
  };
  const freshRead = async (digest, agentId, tabId) => {
    if (!commandTransport(digest).healthy) return false;
    let targetTab = tabId;
    if (targetTab === undefined) {
      const listed = await dispatchBrowserCommand(buildCommand('edge_list_open_tabs').command, 2_500, digest, agentId);
      if (!listed.ok || !Number.isInteger(listed.result?.frontTabId)) return false;
      targetTab = listed.result.frontTabId;
    }
    const built = buildCommand('edge_read_tab', { tabId: targetTab });
    if (built.error) return false;
    const read = await dispatchBrowserCommand(built.command, 2_500, digest, agentId);
    return Boolean(read.ok && read.result?.captureDelivered && store.latest(digest, targetTab)?.capturedAt === read.result.capture?.capturedAt);
  };
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, publicBaseUrl);
    if (requestUrl.pathname === '/agent-grants/pair' && req.method === 'POST') {
      let principal;
      try { principal = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return send(res, 500, { error: 'Agent credential store is unavailable.' }); }
      if (!principal) return send(res, 401, { error: 'Agent credential required.' });
      if (!hasCapability(principal, 'manage_browser_privacy')) return send(res, 403, { error: 'Browser pairing is not allowed.' });
      try {
        const { replacesBrowserId } = await jsonBody(req);
        if (replacesBrowserId !== undefined && (!browserRegistry.byId(replacesBrowserId)
          || !visibleBrowsers(principal).some((browser) => browser.id === replacesBrowserId))) {
          return send(res, 403, { error: 'Browser is not owned by this caller.' });
        }
        const created = pairings.create({ replacesBrowserId });
        return send(res, 201, { code: created.code, expiresAt: created.expiresAt });
      } catch { return send(res, 400, { error: 'Invalid pairing request.' }); }
    }
    if (requestUrl.pathname === '/agent-grants/privacy' && req.method === 'POST') {
      const denyPrivacy = (status, error, principal = null, browserId = null) => {
        audit.write({ tool: 'owner_browser_privacy', outcome: 'denied', agentId: principal?.id || null, browserId, commandId: null, source: 'cockpit-key' });
        return send(res, status, { error });
      };
      let principal;
      try { principal = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return denyPrivacy(500, 'Agent credential store is unavailable.'); }
      if (!principal) return denyPrivacy(401, 'Agent credential required.');
      if (!hasCapability(principal, 'manage_browser_privacy')) return denyPrivacy(403, 'Browser privacy management is not allowed.', principal);
      try {
        const input = await jsonBody(req);
        if (input.private === true && !hasCapability(principal, 'private_browser_local')) return denyPrivacy(403, 'Cockpit key needs private_browser_local before making a browser private.', principal, input.browserId);
        const browser = browserRegistry.setPrivate(input.browserId, input.private);
        audit.write({ tool: 'owner_browser_privacy', outcome: 'ok', agentId: principal.id, browserId: browser.id, commandId: null, source: 'cockpit-key' });
        return send(res, 200, { browserId: browser.id, private: browser.private });
      } catch { return denyPrivacy(400, 'Invalid browser privacy request.', principal); }
    }
    if (requestUrl.pathname === '/agent-grants/final-actions' && req.method === 'POST') {
      let principal;
      try { principal = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return send(res, 500, { error: 'Agent credential store is unavailable.' }); }
      const owner = ownerSessions.authenticate(bearerToken(req));
      if (!principal && !owner) return send(res, 401, { error: 'Owner or agent credential required.' });
      if (!owner && !hasCapability(principal, 'manage_browser_privacy')) return send(res, 403, { error: 'Browser settings management is not allowed.' });
      try {
        const input = await jsonBody(req);
        const browser = browserRegistry.setAskBeforeFinalActions(input.browserId, input.askBeforeFinalActions);
        audit.write({ tool: 'owner_browser_final_actions', outcome: 'ok', agentId: owner ? 'owner' : principal.id, browserId: browser.id, commandId: null, source: owner ? 'owner' : 'cockpit-key' });
        return send(res, 200, { browserId: browser.id, askBeforeFinalActions: browser.askBeforeFinalActions });
      } catch (error) {
        audit.write({ tool: 'owner_browser_final_actions', outcome: 'denied', agentId: owner ? 'owner' : principal.id, browserId: null, commandId: null, source: owner ? 'owner' : 'cockpit-key' });
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === 'GET' && ['/agent-grants/extension-update', '/agent-grants/extension-update/download'].includes(requestUrl.pathname)) {
      let principal;
      try { principal = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return send(res, 500, { error: 'Agent credential store is unavailable.' }); }
      const owner = ownerSessions.authenticate(bearerToken(req));
      if (!principal && !owner) return send(res, 401, { error: 'Owner or agent credential required.' });
      if (!owner && !hasCapability(principal, 'manage_browser_privacy')) return send(res, 403, { error: 'Browser settings management is not allowed.' });
      try {
        const selected = extensionPackage(resolve(env.FBB_EXTENSION_DIST_DIR || join(root, 'dist')));
        if (!selected) return send(res, 404, { error: 'No extension package is available on this server.' });
        if (requestUrl.pathname.endsWith('/download')) {
          audit.write({ tool: 'owner_extension_download', outcome: 'ok', agentId: owner ? 'owner' : principal.id, browserId: null, commandId: null, source: owner ? 'owner' : 'cockpit-key' });
          res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${selected.filename}"`, 'cache-control': 'no-store', 'content-length': selected.bytes });
          return createReadStream(selected.path).pipe(res);
        }
        const sha256 = createHash('sha256').update(readFileSync(selected.path)).digest('hex');
        return send(res, 200, { version: selected.version, filename: selected.filename, bytes: selected.bytes, sha256 });
      } catch { return send(res, 500, { error: 'Extension package is unavailable.' }); }
    }
    if (requestUrl.pathname === '/agent-grants/approver' && req.method === 'POST') {
      let principal;
      try { principal = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return send(res, 500, { error: 'Agent credential store is unavailable.' }); }
      if (!principal) return send(res, 401, { error: 'Agent credential required.' });
      if (!hasCapability(principal, 'manage_browser_privacy')) return send(res, 403, { error: 'Approval link management is not allowed.' });
      try {
        const created = approverStore.create({ label: (await jsonBody(req)).label });
        audit.write({ tool: 'owner_approver_create', outcome: 'ok', agentId: principal.id, browserId: null, commandId: null, source: 'cockpit-key' });
        return send(res, 200, created);
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    const cloudLogMatch = requestUrl.pathname.match(/^\/agent-grants\/cloud-received\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,99})$/u);
    if (cloudLogMatch && req.method === 'GET') {
      const issuer = agentTokenStore.authenticate(bearerToken(req));
      if (!issuer) return send(res, 401, { error: 'Agent credential required.' });
      if (!hasCapability(issuer, 'delegate_runs')) return send(res, 403, { error: 'Run delegation is not allowed.' });
      return send(res, 200, { runId: cloudLogMatch[1], entries: await cloudReceived.read(cloudLogMatch[1]) });
    }
    if ((requestUrl.pathname === '/agent-grants' && req.method === 'POST') || (/^\/agent-grants\/[^/]+$/u.test(requestUrl.pathname) && req.method === 'DELETE')) {
      let issuer;
      try { issuer = agentTokenStore.authenticate(bearerToken(req)); }
      catch { return send(res, 500, { error: 'Agent credential store is unavailable.' }); }
      if (!issuer) return send(res, 401, { error: 'Agent credential required.' });
      if (!hasCapability(issuer, 'delegate_runs')) return send(res, 403, { error: 'Run delegation is not allowed.' });
      if (req.method === 'DELETE') {
        let runId;
        try { runId = decodeURIComponent(requestUrl.pathname.slice('/agent-grants/'.length)); }
        catch { return send(res, 400, { error: 'Invalid run id.' }); }
        const revoked = runGrants.revoke(runId, issuer.id);
        return send(res, revoked ? 200 : 404, { revoked });
      }
      let input;
      try { input = await jsonBody(req); } catch { return send(res, 400, { error: 'Invalid run grant request.' }); }
      const browserDigest = browserRegistry.byId(input?.browser_id);
      if (!browserDigest) return send(res, 404, { error: 'Browser was not found.' });
      if (browserRegistry.byDigest(browserDigest)?.private === true && listBrowsers().find((browser) => browser.id === input.browser_id)?.swap.active !== true) return send(res, 403, { error: privateBrowserMessage });
      try {
        const issuerVersion = agentTokenStore.list().find((agent) => agent.id === issuer.id)?.credentialVersion;
        const grant = runGrants.issue({ runId: input.run_id, browserId: input.browser_id, lane: input.lane, ttlSeconds: input.ttl_seconds, issuerId: issuer.id, issuerVersion, issuerCapabilities: issuer.capabilities });
        return send(res, 201, { ...grant, mcp_url: `${publicBaseUrl}/mcp` });
      } catch { return send(res, 400, { error: 'Invalid or duplicate run grant request.' }); }
    }
    if (req.method === 'GET' && ['/contract/v1/browsers', '/contract/v1/me'].includes(requestUrl.pathname) || req.method === 'GET' && /^\/contract\/v1\/browsers\/[^/]+\/(?:status|screenshot)$/.test(requestUrl.pathname)) {
      if (req.headers['fbb-contract-version'] !== '1') return res.writeHead(426, { 'content-type': 'application/json', 'cache-control': 'no-store', 'fbb-supported-versions': '1' }).end(JSON.stringify({ error: { code: 'contract_version_unsupported', message: 'Supported contract version: 1.' } }));
      let principal;
      try { principal = mcpPrincipal(req); } catch { return contractError(res, 401, 'unauthorized', 'Agent credential is unavailable.'); }
      if (!principal) return contractError(res, 401, 'unauthorized', 'Provide an agent credential.');
      if (!hasCapability(principal, 'browser.read')) return contractError(res, 403, 'capability_denied', 'This agent cannot read browsers.');
      if (requestUrl.pathname === '/contract/v1/me') return send(res, 200, { agentId: principal.id, displayName: principal.id, capabilities: principal.capabilities });
      if (requestUrl.pathname === '/contract/v1/browsers') return send(res, 200, { browsers: visibleBrowsers(principal).map(({ id, name, online, controlEnabled, extensionVersion, shareDelegatedRuns, private: isPrivate, askBeforeFinalActions, swap }) => {
        const age = commandQueue.transportStatus(browserRegistry.byId(id)).lastLeaseAgeMs;
        return { id, name, kind: 'extension', online, controlEnabled, private: isPrivate, swap, askBeforeFinalActions, shareDelegatedRuns, extensionVersion: extensionVersion || null, minimumExtensionVersion: MINIMUM_EXTENSION_VERSION, lastSeenAt: Number.isFinite(age) ? new Date(Date.now() - age).toISOString() : null };
      }), defaultBrowserId: visibleBrowsers(principal).some((browser) => browser.isDefault) ? browserRegistry.byDigest(browserRegistry.defaultDigest())?.id : null });
      const [, browserId, route] = requestUrl.pathname.match(/^\/contract\/v1\/browsers\/([^/]+)\/(status|screenshot)$/);
      const digest = browserRegistry.byId(browserId);
      if (!digest) return contractError(res, 404, 'browser_unknown', 'That browser is not known.');
      if (!mayUseBrowser(principal, browserId)) return contractError(res, 403, 'private_browser', privateBrowserMessage);
      if (!commandQueue.isOnline(digest)) return contractError(res, 409, 'browser_offline', 'That browser is offline.');
      if (route === 'status') {
        const capture = store.latest(digest);
        const holder = agentControlLease.status({ browserId: digest });
        return send(res, 200, { online: true, controlEnabled: commandQueue.controlEnabled(digest), activeTab: capture && allowedUrl(capture.url, policy) ? { title: capture.title, url: displayUrl(capture.url, policy) } : null, capturedAt: capture?.capturedAt || null, controlHolder: holder.holder ? { agentId: holder.holder, expiresAt: holder.expiresAt } : null, humanTakeover: handoffLease.status({ browserId: digest }).claimed });
      }
      if (policy.capture?.screenshotEnabled !== true) return contractError(res, 403, 'capability_denied', 'Screenshot capture is disabled by broker policy.');
      if (policy.capture?.hideDuringHumanTakeover === true && handoffLease.status({ browserId: digest }).claimed) return contractError(res, 409, 'human_takeover_active', 'The view is paused during human takeover.');
      let frame = liveFrames.get(digest);
      if (!frame || Date.now() - frame.savedAt >= 1_000) {
        let pending = liveFramesInFlight.get(digest);
        if (!pending) {
          pending = captureScreenshot(digest, principal.id).then((result) => {
            if (result.image) liveFrames.set(digest, { ...result, savedAt: Date.now() });
            return result;
          }).finally(() => liveFramesInFlight.delete(digest));
          liveFramesInFlight.set(digest, pending);
        }
        frame = await pending;
      }
      if (!frame.image) return contractError(res, frame.code === 'browser_offline' ? 409 : 403, frame.code, frame.message);
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'fbb-browser-id': browserId, 'fbb-captured-at': frame.capturedAt }).end(frame.image);
    }
    const eventsMatch = requestUrl.pathname.match(/^\/contract\/v1\/browsers\/(brw_[a-f0-9]{16})\/events$/);
    if (eventsMatch && req.method === 'GET') {
      let principal = null;
      try { principal = mcpPrincipal(req); } catch {}
      const owner = ownerSessions.authenticate(bearerToken(req));
      if (!owner && !principal) return send(res, 401, { error: { code: 'unauthorized', message: 'Sign in or provide an agent key.' } });
      if (!owner && !hasCapability(principal, 'browser.read')) return send(res, 403, { error: { code: 'capability_denied', message: 'This agent cannot read browser events.' } });
      const browserDigest = browserRegistry.byId(eventsMatch[1]);
      if (!browserDigest) return send(res, 404, { error: { code: 'browser_unknown', message: 'That browser is not known.' } });
      if (!owner && !mayUseBrowser(principal, eventsMatch[1])) return contractError(res, 403, 'private_browser', privateBrowserMessage);
      const after = requestUrl.searchParams.get('after');
      const result = after === null ? eventLog.since(browserDigest, '0') : await eventLog.wait(browserDigest, after, 25_000);
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/contract/v1/approvals' && req.method === 'GET') {
      let principal = null;
      try { principal = mcpPrincipal(req); } catch {}
      const owner = ownerSessions.authenticate(bearerToken(req));
      if (!owner && !principal) return send(res, 401, { error: { code: 'unauthorized', message: 'Sign in or provide an agent key.' } });
      if (!owner && !hasCapability(principal, 'browser.read')) return send(res, 403, { error: { code: 'capability_denied', message: 'This agent cannot read pending approvals.' } });
      const browserDigest = browserRegistry.byId(requestUrl.searchParams.get('browserId'));
      if (!browserDigest) return send(res, 404, { error: { code: 'browser_unknown', message: 'That browser is not known.' } });
      if (!owner && !mayUseBrowser(principal, requestUrl.searchParams.get('browserId'))) return contractError(res, 403, 'private_browser', privateBrowserMessage);
      const approvals = verifiedActions.pendingForBrowser(browserDigest).map((snapshot) => ({
        ...publicVerifiedAction(snapshot),
        ...(passkeyApprovalsEnabled ? { approveUrl: `${publicBaseUrl}/approve/${encodeURIComponent(snapshot.proposal.transactionId)}` } : {})
      }));
      for (const read of pendingReads.values()) if (read.browserDigest === browserDigest) approvals.push(read.card);
      return send(res, 200, { approvals });
    }
    const approvalPageMatch = requestUrl.pathname.match(/^\/approve\/([^/]+)$/);
    if (approvalPageMatch && req.method === 'GET') {
      if (!passkeyApprovalsEnabled) return send(res, 404, { error: { code: 'approval_expired', message: 'This approval request is unavailable.' } });
      let transactionId;
      try { transactionId = decodeURIComponent(approvalPageMatch[1]); } catch { return send(res, 404, { error: { code: 'approval_expired', message: 'This approval request is unavailable.' } }); }
      let snapshot;
      try { snapshot = verifiedActions.get(transactionId); } catch { snapshot = null; }
      if (!snapshot || snapshot.phase !== 'proposed') return send(res, 404, { error: { code: 'approval_expired', message: 'This approval request is unavailable.' } });
      const transaction = publicVerifiedAction(snapshot);
      const changes = transaction.proposal.changes.map((change) => `<li><strong>${htmlEscape(change.field)}</strong><br>From: ${htmlEscape(change.from ?? 'Not shown')}<br>To: ${htmlEscape(change.to)}</li>`).join('');
      const commit = transaction.proposal.target?.operation?.commit || {};
      const transactionJson = JSON.stringify(transactionId);
      return sendHtml(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve verified action</title><style>body{font:20px/1.5 system-ui,sans-serif;background:#111;color:#fff;margin:0;padding:24px}main{max-width:42rem;margin:4vh auto}section{border:2px solid #777;border-radius:12px;padding:1rem;margin:1rem 0}button{width:100%;font:700 1.05em system-ui;padding:.9em;margin:.4em 0;border:0;border-radius:8px}.approve{background:#ffd400;color:#000}.reject{background:#ff7272;color:#190000}#status{min-height:2rem;font-weight:700}</style></head><body><main><h1>Approve verified action</h1><section><h2>${htmlEscape(transaction.proposal.intent)}</h2><p><strong>Origin:</strong> ${htmlEscape(transaction.proposal.target?.origin || '')}</p><ul>${changes}</ul><p><strong>Commit control:</strong> ${htmlEscape(commit.targetText || commit.selector || 'Specified control')}</p></section><button class="approve" data-decision="approve">Approve with passkey</button><button class="reject" data-decision="reject">Reject with passkey</button><p id="status" role="status"></p></main><script>const transactionId=${transactionJson};const status=document.querySelector('#status');const bytes=(value)=>{const raw=value.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(raw+'='.repeat((4-raw.length%4)%4)),c=>c.charCodeAt(0))};const b64=(value)=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');async function decide(decision){status.textContent='Waiting for your passkey…';try{const challengeResponse=await fetch('/contract/v1/approvals/'+encodeURIComponent(transactionId)+'/challenge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const options=await challengeResponse.json();if(!challengeResponse.ok)throw new Error(options.error.message);const credential=await navigator.credentials.get({publicKey:{challenge:bytes(options.challenge),rpId:${JSON.stringify(rpId)},allowCredentials:options.allowCredentials.map(item=>({type:'public-key',id:bytes(item.id)})),userVerification:'required'}});const response=await fetch('/contract/v1/approvals/'+encodeURIComponent(transactionId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,proposalHash:options.proposalHash,credentialId:credential.id,authenticatorData:b64(credential.response.authenticatorData),clientDataJSON:b64(credential.response.clientDataJSON),signature:b64(credential.response.signature)})});const result=await response.json();if(!response.ok)throw new Error(result.error.message);status.textContent=decision==='approve'?'Approved.':'Rejected.'}catch(error){status.textContent=error.message}}document.querySelectorAll('[data-decision]').forEach(button=>button.addEventListener('click',()=>decide(button.dataset.decision)));</script></body></html>`);
    }
    const approvalChallengeMatch = requestUrl.pathname.match(/^\/contract\/v1\/approvals\/([^/]+)\/challenge$/);
    if (approvalChallengeMatch && req.method === 'POST') {
      if (!passkeyApprovalsEnabled) return send(res, 404, { error: { code: 'approval_expired', message: 'This approval request is unavailable.' } });
      let transactionId;
      try { transactionId = decodeURIComponent(approvalChallengeMatch[1]); await jsonBody(req); } catch { return send(res, 400, { error: { code: 'passkey_invalid', message: 'The approval challenge request was invalid.' } }); }
      let snapshot;
      try { snapshot = verifiedActions.get(transactionId); } catch { snapshot = null; }
      if (!snapshot || snapshot.phase !== 'proposed') return send(res, 410, { error: { code: 'approval_expired', message: 'This approval request expired.' } });
      const browserDigest = snapshot.proposal.target.browserId;
      if (!verifiedActions.pendingForBrowser(browserDigest).some((pending) => pending.proposal.transactionId === transactionId)) return send(res, 410, { error: { code: 'approval_expired', message: 'This approval request expired.' } });
      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + 2 * 60_000;
      approvalChallenges.set(transactionId, { challenge, transactionId, proposalHash: snapshot.proposalHash, expiresAt, used: false });
      return send(res, 200, {
        challenge, proposalHash: snapshot.proposalHash, expiresAt: new Date(expiresAt).toISOString(),
        allowCredentials: passkeyStore.list().map((credential) => ({ type: 'public-key', id: credential.credentialId }))
      });
    }
    const sessionApprovalDecisionMatch = requestUrl.pathname.match(/^\/contract\/v1\/approvals\/([^/]+)\/decision$/);
    if (sessionApprovalDecisionMatch && req.method === 'POST') {
      const credential = approverStore.authenticate(bearerToken(req));
      if (!credential) return send(res, 401, { error: { code: 'unauthorized', message: 'Provide a valid approval credential.' } });
      let transactionId;
      let input;
      try { transactionId = decodeURIComponent(sessionApprovalDecisionMatch[1]); input = await jsonBody(req); }
      catch { return send(res, 410, { error: { code: 'approval_expired', message: 'This request was already decided or expired.' } }); }
      const pendingRead = pendingReads.get(transactionId);
      if (pendingRead) {
        if (input?.proposalHash !== pendingRead.card.proposalHash) return send(res, 409, { error: { code: 'proposal_changed', message: 'The proposal changed after this approval card was shown.' } });
        if (!['approve', 'reject'].includes(input?.decision)) return send(res, 400, { error: { code: 'invalid_decision', message: 'Choose Continue or Cancel.' } });
        pendingReads.delete(transactionId);
        clearTimeout(pendingRead.timer);
        pendingRead.resolve(input.decision === 'approve');
        return send(res, 200, { ok: true, transaction: { ...pendingRead.card, phase: input.decision === 'approve' ? 'approved' : 'rejected' } });
      }
      let snapshot;
      try { snapshot = verifiedActions.get(transactionId); } catch { snapshot = null; }
      if (!snapshot || snapshot.phase !== 'proposed') return send(res, 410, { error: { code: 'approval_expired', message: 'This request was already decided or expired.' } });
      const browserDigest = snapshot.proposal.target.browserId;
      if (!verifiedActions.pendingForBrowser(browserDigest).some((pending) => pending.proposal.transactionId === transactionId)) {
        return send(res, 410, { error: { code: 'approval_expired', message: 'This request was already decided or expired.' } });
      }
      if (input?.proposalHash !== snapshot.proposalHash) return send(res, 409, { error: { code: 'proposal_changed', message: 'The proposal changed after this approval card was shown.' } });
      const browser = browserRegistry.byDigest(browserDigest);
      if (!browser) return send(res, 404, { error: { code: 'browser_unknown', message: 'The browser for this approval is no longer known.' } });
      const username = typeof input?.approver === 'string' ? input.approver.trim() : '';
      if (!['approve', 'reject'].includes(input?.decision) || !username || username.length > 100 || /[\r\n]/.test(username)) {
        return send(res, 410, { error: { code: 'approval_expired', message: 'This request was already decided or expired.' } });
      }
      try {
        const decision = { browserId: browserDigest, approverId: `cockpit:${credential.id}:${username}`, proposalHash: input.proposalHash };
        const decided = applySingleClickDecision(transactionId, input.decision, decision);
        audit.write({
          tool: 'approval_decision', outcome: input.decision === 'approve' ? 'approved' : 'rejected',
          agentId: `cockpit:${credential.id}`, browserId: browser.id, commandId: null, target: transactionId, approver: username
        });
        return send(res, 200, { ok: true, transaction: publicVerifiedAction(decided) });
      } catch (error) {
        if (error?.message === 'proposal hash does not match') return send(res, 409, { error: { code: 'proposal_changed', message: 'The proposal changed after this approval card was shown.' } });
        return send(res, 410, { error: { code: 'approval_expired', message: 'This request was already decided or expired.' } });
      }
    }
    const approvalDecisionMatch = requestUrl.pathname.match(/^\/contract\/v1\/approvals\/([^/]+)$/);
    if (approvalDecisionMatch && req.method === 'POST') {
      if (!passkeyApprovalsEnabled) return send(res, 404, { error: { code: 'approval_expired', message: 'This approval request is unavailable.' } });
      let transactionId;
      let input;
      try { transactionId = decodeURIComponent(approvalDecisionMatch[1]); input = await jsonBody(req); } catch { return send(res, 400, { error: { code: 'passkey_invalid', message: 'The approval decision request was invalid.' } }); }
      if (!input || !['approve', 'reject'].includes(input.decision) || !input.credentialId || !input.authenticatorData || !input.clientDataJSON || !input.signature) {
        return send(res, 401, { error: { code: 'passkey_required', message: 'Approve or reject with a registered passkey.' } });
      }
      const challenge = approvalChallenges.get(transactionId);
      if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) return send(res, 401, { error: { code: 'passkey_invalid', message: 'The passkey assertion was invalid or already used.' } });
      let snapshot;
      try { snapshot = verifiedActions.get(transactionId); } catch { snapshot = null; }
      if (!snapshot || snapshot.proposalHash !== challenge.proposalHash || input.proposalHash !== challenge.proposalHash) {
        return send(res, 409, { error: { code: 'proposal_changed', message: 'The proposal changed after this approval page was opened.' } });
      }
      const credential = passkeyStore.get(input.credentialId);
      if (!credential) return send(res, 401, { error: { code: 'passkey_invalid', message: 'The passkey assertion was invalid or already used.' } });
      try {
        const verified = verifyAssertion({
          credential, authenticatorData: input.authenticatorData, clientDataJSON: input.clientDataJSON,
          signature: input.signature, expectedChallenge: challenge.challenge, rpId, origin: passkeyOrigin
        });
        passkeyStore.updateSignCount(credential.credentialId, verified.signCount);
        challenge.used = true;
        const decision = {
          browserId: snapshot.proposal.target.browserId,
          approverId: `owner-passkey:${credential.credentialId.slice(0, 12)}`,
          proposalHash: input.proposalHash
        };
        const decided = applySingleClickDecision(transactionId, input.decision, decision);
        const browser = browserRegistry.byDigest(snapshot.proposal.target.browserId);
        audit.write({ tool: 'approval_decision', outcome: input.decision === 'approve' ? 'approved' : 'rejected', agentId: 'owner', browserId: browser?.id || null, commandId: null, target: transactionId });
        return send(res, 200, { ok: true, transaction: publicVerifiedAction(decided) });
      } catch (error) {
        if (error?.message === 'proposal expired') return send(res, 410, { error: { code: 'approval_expired', message: 'This approval request expired.' } });
        if (error?.message === 'proposal hash does not match') return send(res, 409, { error: { code: 'proposal_changed', message: 'The proposal changed after this approval page was opened.' } });
        return send(res, 401, { error: { code: 'passkey_invalid', message: 'The passkey assertion was invalid or already used.' } });
      }
    }
    const handoffPath = requestUrl.pathname === '/work-edge/browser/handoff' ? 'status'
      : requestUrl.pathname === '/work-edge/browser/handoff/claim' ? 'claim'
        : requestUrl.pathname === '/work-edge/browser/handoff/release' ? 'release' : null;
    if (handoffPath && ((handoffPath === 'status' && req.method === 'GET') || (handoffPath !== 'status' && req.method === 'POST'))) {
      const controller = authenticateHandoffController(req);
      if (!controller?.id) return send(res, 401, { error: 'Unauthorized.' });
      const resolvedBrowser = resolveBrowser(requestUrl.searchParams.has('browserId') ? { browserId: requestUrl.searchParams.get('browserId') } : {});
      if (!resolvedBrowser.ok) return send(res, 409, { error: resolvedBrowser.message, code: resolvedBrowser.code, ...(resolvedBrowser.browserId ? { browserId: resolvedBrowser.browserId } : {}) });
      const browserId = resolvedBrowser.digest;
      try {
        const state = handoffPath === 'claim'
          ? handoffLease.claim({ browserId, controllerIdentity: controller.id, activeAgentIdentity })
          : handoffPath === 'release'
            ? handoffLease.release({ browserId, controllerIdentity: controller.id, activeAgentIdentity })
            : handoffLease.status({ browserId, activeAgentIdentity });
        return send(res, 200, state);
      } catch (error) { return send(res, 409, { error: error.message }); }
    }
    const metadata = req.method === 'GET' ? oauth.metadata(requestUrl.pathname) : null;
    if (metadata) return sendJson(res, 200, metadata);
    if (req.method === 'POST' && requestUrl.pathname === '/register') {
      try { return sendJson(res, 201, oauth.register(await readRequestBody(req), { ip: clientIp(req, trustedProxies) })); }
      catch (error) { return sendJson(res, error.code === 'body_too_large' ? 413 : error.status === 429 ? 429 : 400, { error: 'invalid_client_metadata', error_description: error.message }); }
    }
    if (req.method === 'GET' && requestUrl.pathname === '/authorize') {
      try { return redirect(res, oauth.authorize(Object.fromEntries(requestUrl.searchParams))); }
      catch (error) { return sendJson(res, 400, { error: 'invalid_request', error_description: error.message }); }
    }
    if (req.method === 'GET' && requestUrl.pathname === '/login') return sendHtml(res, 200, oauth.loginPage(requestUrl.searchParams.get('req') || ''));
    if (req.method === 'POST' && requestUrl.pathname === '/login') {
      try {
        const input = await readRequestBody(req, { form: true });
        const result = await oauth.login({ requestId: input.req, passphrase: input.passphrase, ip: clientIp(req, trustedProxies) });
        if (result.location) return redirect(res, result.location);
        return sendHtml(res, result.status, result.html);
      } catch (error) {
        return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { error: 'invalid_request' });
      }
    }
    if (req.method === 'POST' && requestUrl.pathname === '/token') {
      try { return sendJson(res, 200, oauth.exchange(await readRequestBody(req, { form: true }), req.headers.authorization)); }
      catch (error) {
        const status = error.message === 'invalid_client' ? 401 : error.code === 'body_too_large' ? 413 : 400;
        return sendJson(res, status, { error: error.message === 'invalid_client' ? 'invalid_client' : error.message === 'unsupported_grant_type' ? 'unsupported_grant_type' : 'invalid_grant' });
      }
    }
    if (req.method === 'POST' && requestUrl.pathname === '/revoke') {
      try { oauth.revoke((await readRequestBody(req, { form: true })).token); return sendEmpty(res, 200); }
      catch (error) { return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { error: 'invalid_request' }); }
    }
    const pairPath = req.url === '/pair/create' || req.url === '/work-edge/pair/create' ? 'create'
      : req.url === '/pair/exchange' || req.url === '/work-edge/pair/exchange' ? 'exchange'
        : req.url === '/pair/status' || req.url === '/work-edge/pair/status' ? 'status' : null;
    if (req.method === 'POST' && pairPath) {
      if (pairPath === 'create') {
        if (!devToken) return send(res, 503, { error: 'Pairing administration is disabled: set WORK_EDGE_DEV_TOKEN.' });
        if (!bearerMatches(req, devToken)) return send(res, 401, { error: 'Unauthorized.' });
        try { await jsonBody(req); return send(res, 201, pairings.create()); } catch { return send(res, 400, { error: 'Invalid pairing request.' }); }
      }
      if (pairPath === 'exchange') {
        try {
          const result = pairings.exchange((await jsonBody(req)).code);
          if (!result) return send(res, 401, { error: 'Invalid, expired, or already used pairing code.' });
          if (result.replacesBrowserId) {
            try {
              const { oldDigest } = browserRegistry.replaceToken(result.replacesBrowserId, tokenDigest(result.token));
              tokenStore.revoke(oldDigest);
              const socket = liveSockets.get(oldDigest);
              if (socket) { socketUnavailable(oldDigest, socket); socket.destroy(); }
              commandQueue.cancelPendingForBrowser(oldDigest);
              audit.write({ tool: 'browser_repaired', outcome: 'ok', browserId: result.replacesBrowserId, agentId: 'owner' });
            } catch (error) { tokenStore.revoke(tokenDigest(result.token)); throw error; }
          }
          const { replacesBrowserId: _replaced, ...publicResult } = result;
          return send(res, 200, publicResult);
        } catch (error) { return send(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Invalid pairing request.' : 'Unable to complete pairing.' }); }
      }
      try { return pairedBrowserAuthorized(req) ? send(res, 200, { paired: true }) : send(res, 401, { error: 'Unauthorized.' }); } catch { return send(res, 500, { error: 'Paired token store is unavailable.' }); }
    }
    if (req.method === 'POST' && (req.url === '/ingest' || req.url === '/work-edge/ingest')) {
      try {
        if (!tokenStore.read().tokenHashes.length) return send(res, 503, { error: 'Ingest is disabled: pair a browser first.' });
        if (!pairedBrowserAuthorized(req)) return send(res, 401, { error: 'Unauthorized.' });
      } catch { return send(res, 500, { error: 'Paired token store is unavailable.' }); }
      try {
        const browserId = tokenDigest(bearerToken(req));
        browserRegistry.ensure(browserId);
        if (browserRegistry.byDigest(browserId)?.private === true && swapStates.get(browserId)?.active !== true) {
          return send(res, 403, { error: 'Private captures require active client-detail swapping.' });
        }
        const capture = normalizeCapture(await jsonBody(req, 2_000_000), policy);
        store.put(browserId, capture);
        return send(res, 202, { ok: true, capture: { title: capture.title, url: displayUrl(capture.url, policy), capturedAt: capture.capturedAt } });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && (req.url === '/ingest-screenshot' || req.url === '/work-edge/ingest-screenshot')) {
      if (policy.capture?.screenshotEnabled !== true) return send(res, 403, { error: 'Screenshot capture is disabled by broker policy.' });
      const token = bearerToken(req);
      try {
        if (!tokenStore.matches(token)) return send(res, 401, { error: 'Unauthorized.' });
      } catch { return send(res, 500, { error: 'Paired token store is unavailable.' }); }
      try {
        const browserId = tokenDigest(token);
        if (browserRegistry.byDigest(browserId)?.private === true) return send(res, 403, { error: 'Screenshots are unavailable for private browsers.' });
        const screenshot = normalizeScreenshot(await jsonBody(req, MAX_SCREENSHOT_DATA_URL_BYTES + 10_000), policy);
        const command = commandQueue.record(screenshot.commandId);
        if (!command || command.browserId !== browserId || command.command?.type !== 'screenshot' || !['delivered', 'received'].includes(command.state) || command.expiresAt <= Date.now()) return send(res, 409, { error: 'Screenshot does not match an active browser command.' });
        store.putScreenshot(browserId, screenshot);
        return send(res, 202, { ok: true, screenshot: { tabId: screenshot.tabId, url: displayUrl(screenshot.url, policy), capturedAt: screenshot.capturedAt, mimeType: 'image/png', rawScreen: true } });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    const verifiedPath = req.url === '/verified-actions/pending' || req.url === '/work-edge/verified-actions/pending' ? 'pending'
      : req.url === '/verified-actions/approve' || req.url === '/work-edge/verified-actions/approve' ? 'approve'
        : req.url === '/verified-actions/reject' || req.url === '/work-edge/verified-actions/reject' ? 'reject' : null;
    if (req.method === 'POST' && verifiedPath) {
      const token = bearerToken(req);
      try {
        if (!tokenStore.matches(token)) return send(res, 401, { error: 'Unauthorized.' });
      } catch { return send(res, 500, { error: 'Paired token store is unavailable.' }); }
      const browserId = tokenDigest(token);
      if (verifiedPath === 'pending') {
        try {
          await jsonBody(req);
          return send(res, 200, { pending: verifiedActions.pendingForBrowser(browserId).map(publicVerifiedAction) });
        } catch { return send(res, 400, { error: 'Invalid pending-action request.' }); }
      }
      try {
        const input = await jsonBody(req);
        const decision = {
          browserId,
          approverId: typeof input.approverId === 'string' ? input.approverId : 'paired-browser-user',
          proposalHash: input.proposalHash,
          reason: input.reason
        };
        const snapshot = applySingleClickDecision(input.transactionId, verifiedPath, decision);
        return send(res, 200, { ok: true, transaction: publicVerifiedAction(snapshot) });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    const commandPath = req.url === '/commands/poll' || req.url === '/work-edge/commands/poll' ? 'poll'
      : req.url === '/commands/result' || req.url === '/work-edge/commands/result' ? 'result' : null;
    if (req.method === 'POST' && commandPath) {
      const token = bearerToken(req);
      try {
        if (!tokenStore.matches(token)) return send(res, 401, { error: 'Unauthorized.' });
      } catch { return send(res, 500, { error: 'Paired token store is unavailable.' }); }
      if (commandPath === 'poll') {
        let input = {};
        try { input = await jsonBody(req); } catch { return send(res, 400, { error: 'Invalid command poll request.' }); }
        if (!isSupportedExtensionVersion(typeof input?.extensionVersion === 'string' ? input.extensionVersion : null)) {
          return send(res, 426, { error: `Extension version ${input?.extensionVersion || 'unknown'} is below the minimum supported version ${MIN_SUPPORTED_EXTENSION_VERSION}.` });
        }
        const waitMs = boundedTimeout(input?.waitMs, 25_000, 30_000);
        const browserId = tokenDigest(token);
        browserRegistry.ensure(browserId);
        acceptSwap(browserId, input?.swap);
        const command = await commandQueue.poll(browserId, waitMs, input?.controlEnabled === true, input?.extensionVersion, input?.runnerDiagnostic);
        return send(res, 200, { ok: true, command });
      }
      try {
        const input = await jsonBody(req, 2_000_000);
        if (!input || typeof input.id !== 'string' || typeof input.ok !== 'boolean') return send(res, 400, { error: 'Invalid command result.' });
        const accepted = commandQueue.submitResult(tokenDigest(token), input.id, { ok: input.ok, result: input.result, error: typeof input.error === 'string' ? input.error.slice(0, 1000) : undefined, code: BROWSER_RESULT_CODES.has(input.code) ? input.code : undefined });
        return send(res, accepted ? 202 : 404, accepted ? { ok: true } : { error: 'Command is unknown or expired.' });
      } catch { return send(res, 400, { error: 'Invalid command result.' }); }
    }
    const ownerPath = requestUrl.pathname.startsWith('/work-edge/owner/') ? requestUrl.pathname.slice('/work-edge/owner/'.length) : null;
    if (ownerPath) {
      const ownerAudit = (tool, outcome, target, cancelled) => audit.write({ tool, outcome, agentId: 'owner', browserId: null, commandId: null, target, cancelled });
      const ownerTool = ownerPath === 'session' ? 'owner_session'
        : ownerPath === 'browsers' && req.method === 'GET' ? 'owner_browser_list'
        : ownerPath === 'agents' && req.method === 'GET' ? 'owner_agent_list'
          : ownerPath === 'agents' && req.method === 'POST' ? 'owner_agent_create'
            : ownerPath === 'agents/revoke' && req.method === 'POST' ? 'owner_agent_revoke'
              : ownerPath === 'web-apps/revoke' && req.method === 'POST' ? 'owner_web_app_revoke'
                : ownerPath === 'approvers' && req.method === 'POST' ? 'owner_approver_create'
                  : ownerPath === 'approvers/list' && req.method === 'POST' ? 'owner_approver_list'
                    : ownerPath === 'approvers/revoke' && req.method === 'POST' ? 'owner_approver_revoke'
                : ownerPath === 'pair' && req.method === 'POST' ? 'owner_pair'
                  : ownerPath === 'passkeys' && req.method === 'POST' ? 'owner_passkey_register'
                    : ownerPath === 'passkeys/remove' && req.method === 'POST' ? 'owner_passkey_remove'
                      : ownerPath.startsWith('passkeys') ? 'owner_passkey_list'
                  : 'owner_unknown';
      if (ownerPath === 'session' && req.method === 'POST') {
        try {
          const result = await ownerSessions.signIn({ passphrase: (await jsonBody(req)).passphrase, ip: clientIp(req, trustedProxies) });
          ownerAudit('owner_session', result.status === 200 ? 'signed_in' : 'denied');
          const { status, ...response } = result;
          return send(res, status, response);
        } catch {
          ownerAudit('owner_session', 'invalid');
          return send(res, 400, { error: 'Invalid owner sign-in request.' });
        }
      }
      if (ownerPath.startsWith('passkeys') && !passkeyApprovalsEnabled) {
        return send(res, 404, { error: 'Passkey approvals are not enabled.' });
      }
      if (ownerPath === 'passkeys' && req.method === 'GET') {
        return sendHtml(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner passkeys</title><style>body{font:20px/1.5 system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:1rem;background:#101418;color:#fff}main{display:grid;gap:1rem}label{display:grid;gap:.35rem;font-weight:700}button,input{box-sizing:border-box;width:100%;font:inherit;padding:.85rem;border-radius:.45rem}input{background:#fff;color:#000;border:2px solid #fff}button{background:#76e6a6;color:#07130c;border:2px solid #76e6a6;font-weight:800}li{margin:.75rem 0;padding:1rem;border:2px solid #c8d1da;border-radius:.5rem}li button{margin-top:.75rem;background:#ffd1d1;color:#300;border-color:#ffd1d1}#status{min-height:2rem;font-weight:700}</style></head><body><main><h1>Owner passkeys</h1><label for="passphrase">Owner passphrase</label><input id="passphrase" type="password" autocomplete="current-password"><label for="label">Passkey label</label><input id="label" maxlength="80" value="Owner passkey"><button id="register" type="button">Sign in and add a passkey on this device</button><ul id="passkeys"></ul><p id="status" role="status"></p></main><script>let token='';const status=document.querySelector('#status');const list=document.querySelector('#passkeys');const bytes=(value)=>{const raw=value.split('-').join('+').split('_').join('/');return Uint8Array.from(atob(raw+'='.repeat((4-raw.length%4)%4)),c=>c.charCodeAt(0))};const b64=(value)=>btoa(String.fromCharCode(...new Uint8Array(value))).split('+').join('-').split('/').join('_').replace(/=+$/,'');const errorMessage=(result)=>typeof result.error==='string'?result.error:result.error?.message||'Request failed.';async function signIn(){const response=await fetch('/work-edge/owner/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:document.querySelector('#passphrase').value})});const result=await response.json();if(!response.ok)throw new Error(errorMessage(result));token=result.token}async function call(path,body){const response=await fetch(path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok){const result=await response.json();throw new Error(errorMessage(result))}return response}async function refreshList(){const result=await(await call('/work-edge/owner/passkeys/list',{})).json();list.replaceChildren();result.passkeys.forEach(passkey=>{const item=document.createElement('li');const label=document.createElement('strong');label.textContent=passkey.label;const created=document.createElement('time');created.textContent=passkey.createdAt;created.dateTime=passkey.createdAt;const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.addEventListener('click',async()=>{try{await call('/work-edge/owner/passkeys/remove',{credentialId:passkey.credentialId});await refreshList();status.textContent='Passkey removed.'}catch(error){status.textContent=error.message}});item.append(label,document.createTextNode(' '),created,remove);list.append(item)})}document.querySelector('#register').addEventListener('click',async()=>{try{status.textContent='Signing in…';await signIn();await refreshList();const options=await(await call('/work-edge/owner/passkeys/options',{})).json();options.publicKey.challenge=bytes(options.publicKey.challenge);options.publicKey.user.id=bytes(options.publicKey.user.id);options.publicKey.authenticatorSelection={ userVerification: 'required', residentKey: 'preferred' };const credential=await navigator.credentials.create(options);await call('/work-edge/owner/passkeys',{attestationObject:b64(credential.response.attestationObject),clientDataJSON:b64(credential.response.clientDataJSON),label:document.querySelector('#label').value});await refreshList();status.textContent='Passkey registered.'}catch(error){status.textContent=error.message}});</script></body></html>`);
      }
      const sessionToken = bearerToken(req);
      if (!ownerSessions.authenticate(sessionToken)) {
        ownerAudit(ownerTool, 'denied');
        return send(res, 401, { error: 'Sign in again with your owner passphrase.' });
      }
      if (ownerPath === 'session' && req.method === 'DELETE') {
        ownerSessions.signOut(sessionToken);
        ownerAudit('owner_session', 'signed_out');
        return sendEmpty(res, 204);
      }
      if (ownerPath === 'approvers' && req.method === 'POST') {
        try {
          const created = approverStore.create({ label: (await jsonBody(req)).label });
          ownerAudit('owner_approver_create', 'created', created.id);
          return send(res, 201, { id: created.id, key: created.key, label: created.label });
        } catch {
          ownerAudit('owner_approver_create', 'invalid');
          return send(res, 400, { error: 'Invalid approval app request.' });
        }
      }
      if (ownerPath === 'approvers/list' && req.method === 'POST') {
        ownerAudit('owner_approver_list', 'ok');
        return send(res, 200, { approvers: approverStore.list() });
      }
      if (ownerPath === 'approvers/revoke' && req.method === 'POST') {
        try {
          const id = (await jsonBody(req)).id;
          const revoked = approverStore.revoke(id);
          ownerAudit('owner_approver_revoke', revoked ? 'revoked' : 'not_found', id);
          return send(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'Approval app was not found.' });
        } catch {
          ownerAudit('owner_approver_revoke', 'invalid');
          return send(res, 400, { error: 'Invalid approval app revocation request.' });
        }
      }
      if (ownerPath === 'passkeys/list' && req.method === 'POST') {
        ownerAudit('owner_passkey_list', 'ok');
        return send(res, 200, { passkeys: passkeyStore.list().map(({ credentialId, label, createdAt }) => ({ credentialId, label, createdAt })) });
      }
      if (ownerPath === 'passkeys/options' && req.method === 'POST') {
        try {
          await jsonBody(req);
          const challenge = randomBytes(32).toString('base64url');
          registrationChallenges.set(sessionToken, { challenge, expiresAt: Date.now() + 2 * 60_000 });
          return send(res, 200, { publicKey: {
            challenge,
            rp: { id: rpId, name: 'Field Browser Bridge' },
            user: { id: randomBytes(32).toString('base64url'), name: 'owner', displayName: 'Owner' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            attestation: 'none'
          } });
        } catch { return send(res, 400, { error: 'Invalid passkey options request.' }); }
      }
      if (ownerPath === 'passkeys' && req.method === 'POST') {
        const challenge = registrationChallenges.get(sessionToken);
        registrationChallenges.delete(sessionToken);
        try {
          if (!challenge || challenge.expiresAt <= Date.now()) throw new Error('passkey_invalid');
          const input = await jsonBody(req);
          const verified = verifyRegistration({
            attestationObject: input.attestationObject,
            clientDataJSON: input.clientDataJSON,
            expectedChallenge: challenge.challenge,
            rpId,
            origin: passkeyOrigin
          });
          const stored = passkeyStore.add({ ...verified, label: input.label });
          ownerAudit('owner_passkey_register', 'registered');
          return send(res, 201, { credentialId: stored.credentialId, label: stored.label, createdAt: stored.createdAt });
        } catch {
          ownerAudit('owner_passkey_register', 'invalid');
          return send(res, 400, { error: 'Passkey registration was invalid.' });
        }
      }
      if (ownerPath === 'passkeys/remove' && req.method === 'POST') {
        try {
          const removed = passkeyStore.remove((await jsonBody(req)).credentialId);
          ownerAudit('owner_passkey_remove', removed ? 'removed' : 'not_found');
          return send(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'Passkey was not found.' });
        } catch {
          ownerAudit('owner_passkey_remove', 'invalid');
          return send(res, 400, { error: 'Invalid passkey removal request.' });
        }
      }
      if (ownerPath === 'agents' && req.method === 'GET') {
        ownerAudit('owner_agent_list', 'ok');
        return send(res, 200, { mcpUrl: `${publicBaseUrl}/mcp`, agents: agentTokenStore.list(), webApps: oauth.listClients(), approvers: approverStore.list() });
      }
      if (ownerPath === 'browsers' && req.method === 'GET') {
        ownerAudit('owner_browser_list', 'ok');
        return send(res, 200, { browsers: listBrowsers().map(({ id, name, online }) => ({ id, name, online })) });
      }
      if (ownerPath === 'browsers/delegated-runs' && req.method === 'POST') {
        try {
          const input = await jsonBody(req);
          const browser = browserRegistry.setDelegatedRunSharing(input.browserId, input.enabled);
          ownerAudit('owner_browser_delegated_runs', 'ok', browser.id);
          return send(res, 200, { browserId: browser.id, shareDelegatedRuns: browser.shareDelegatedRuns });
        } catch {
          return send(res, 400, { error: 'Invalid browser sharing request.' });
        }
      }
      if (ownerPath === 'agents' && req.method === 'POST') {
        try {
          const input = await jsonBody(req);
          const presets = {
            'claude-code': { id: 'claude-code', kind: 'command' },
            codex: { id: 'codex', kind: 'toml' },
            antigravity: { id: 'antigravity', kind: 'json' },
            other: { id: 'other-agent', kind: 'plain' }
          };
          const preset = presets[input?.preset];
          if (!preset) throw new TypeError('Choose Claude Code, Codex, Antigravity, or Other MCP agent.');
          const capabilities = normalizeCapabilities(input.capabilities || ['browser.read', 'browser.control']);
          const activeIds = new Set(agentTokenStore.list().filter((agent) => !agent.revokedAt).map((agent) => agent.id));
          let id = preset.id;
          for (let suffix = 2; activeIds.has(id); suffix += 1) id = `${preset.id}-${suffix}`;
          const created = agentTokenStore.create({ id, capabilities });
          const mcpUrl = `${publicBaseUrl}/mcp`;
          const texts = {
            command: `claude mcp add --transport http field-browser ${mcpUrl} --header "Authorization: Bearer ${created.token}"`,
            toml: `[mcp_servers.field-browser]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${created.token}" }`,
            json: JSON.stringify({ mcpServers: { 'field-browser': { serverUrl: mcpUrl, headers: { Authorization: `Bearer ${created.token}` } } } }),
            plain: `${mcpUrl}\nAuthorization: Bearer ${created.token}`
          };
          ownerAudit('owner_agent_create', 'created', id);
          return send(res, 201, { ...created, mcpUrl, setup: { kind: preset.kind, text: texts[preset.kind] } });
        } catch (error) {
          ownerAudit('owner_agent_create', 'invalid');
          return send(res, 400, { error: error.message || 'Invalid agent request.' });
        }
      }
      if (ownerPath === 'agents/revoke' && req.method === 'POST') {
        try {
          const { id } = await jsonBody(req);
          const revoked = agentTokenStore.revoke(id);
          const cancelled = revoked ? commandQueue.cancelPendingForAgent(id) : 0; if (revoked) seenPages.forgetAgent(id);
          ownerAudit('owner_agent_revoke', revoked ? 'revoked' : 'not_found', typeof id === 'string' ? id : undefined, cancelled);
          return send(res, revoked ? 200 : 404, revoked ? { revoked: true, cancelledCommands: cancelled } : { error: 'Agent was not found.' });
        } catch (error) {
          ownerAudit('owner_agent_revoke', 'invalid');
          return send(res, 400, { error: error.message || 'Invalid agent revoke request.' });
        }
      }
      if (ownerPath === 'web-apps/revoke' && req.method === 'POST') {
        try {
          const { clientId } = await jsonBody(req);
          const revoked = oauth.revokeClient(clientId);
          const cancelled = revoked ? commandQueue.cancelPendingForAgent(`oauth:${clientId}`) : 0; if (revoked) seenPages.forgetAgent(`oauth:${clientId}`);
          ownerAudit('owner_web_app_revoke', revoked ? 'revoked' : 'not_found', typeof clientId === 'string' ? clientId : undefined, cancelled);
          return send(res, revoked ? 200 : 404, revoked ? { revoked: true, cancelledCommands: cancelled } : { error: 'Web app was not found.' });
        } catch (error) {
          ownerAudit('owner_web_app_revoke', 'invalid');
          return send(res, 400, { error: error.message || 'Invalid web app revoke request.' });
        }
      }
      if (ownerPath === 'pair' && req.method === 'POST') {
        try {
          const { replacesBrowserId } = await jsonBody(req);
          if (replacesBrowserId !== undefined && !browserRegistry.byId(replacesBrowserId)) return send(res, 404, { error: 'Browser was not found.' });
          const created = pairings.create({ replacesBrowserId });
          ownerAudit('owner_pair', 'created');
          return send(res, 201, { code: created.code });
        } catch {
          ownerAudit('owner_pair', 'invalid');
          return send(res, 400, { error: 'Invalid pairing request.' });
        }
      }
      ownerAudit('owner_unknown', 'not_found');
      return send(res, 404, { error: 'Owner route was not found.' });
    }
    const mcpPath = requestUrl.pathname === '/mcp' || requestUrl.pathname === '/work-edge/mcp';
    if (mcpPath && req.method === 'GET') return sendEmpty(res, 405, { allow: 'POST, DELETE' });
    if (mcpPath && req.method === 'DELETE') return sendEmpty(res, 200);
    if (!mcpPath || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let principal;
    try { principal = mcpPrincipal(req); }
    catch { return send(res, 500, rpcError(null, -32002, 'Agent credential store is unavailable')); }
    if (!principal) return sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'), { 'www-authenticate': `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"` });
    activeAgentIdentity = principal.id;
    let message; try { message = await jsonBody(req); } catch { return send(res, 400, rpcError(null, -32700, 'Parse error')); }
    if (!isJsonRpcMessage(message)) return send(res, 400, rpcError(null, -32600, 'Invalid Request'));
    if (!expectsJsonRpcResponse(message) || typeof message.method !== 'string') return sendEmpty(res, 202);
    let response;
    if (message.method === 'initialize') response = rpcResult(message.id, {
      protocolVersion: negotiatedProtocolVersion(message.params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'field-browser-bridge', version: SERVER_VERSION },
      instructions: 'Use these tools to inspect and control the paired browser. Browser policy, capability checks, and local approval gates always apply.'
    });
    else if (message.method === 'tools/list') response = rpcResult(message.id, { tools: visibleTools(ALL_TOOLS, principal) });
    else if (message.method === 'tools/call') {
      const requestedTool = message.params?.name;
      const suppliedArgs = message.params?.arguments || {};
      const { args, allowed: scopedBrowserAllowed } = scopeRunBrowserArgs(principal, suppliedArgs);
      // Agents reach for edge_list_tabs first. When the browser can list every open tab (1.1.0+),
      // answer it with the full list instead of the one captured tab.
      const listsAllTabs = () => {
        const browser = resolveBrowser(args);
        if (!browser.ok) return false;
        const transport = commandTransport(browser.digest);
        return transport.healthy && isVersionAtLeast(transport.extensionVersion, '1.1.0');
      };
      const tool = requestedTool === 'edge_list_tabs' && listsAllTabs() ? 'edge_list_open_tabs' : requestedTool;
      const toolDefinition = ALL_TOOLS.find((entry) => entry.name === tool);
      const missingRequiredFields = (toolDefinition?.inputSchema?.required || []).filter((field) => args[field] === undefined);
      const browserCommandTool = BROWSER_COMMAND_TOOLS.includes(tool)
        || (tool === 'edge_find_elements' && args.scope === 'live');
      const prebuiltCommand = browserCommandTool ? buildCommand(tool, args) : null;
      let resolvedBrowser = null;
      const targetBrowser = () => {
        if (!resolvedBrowser) resolvedBrowser = resolveBrowser(args);
        return resolvedBrowser;
      };
      const privacyTarget = () => {
        if (tool.startsWith('edge_verified_action_') || tool === 'edge_verified_receipt') {
          try {
            const transaction = verifiedActions.get(args.transactionId);
            if (transaction?.proposal?.target?.browserId) return browserRegistry.byDigest(transaction.proposal.target.browserId)?.id;
          } catch {}
        }
        return args.browserId ?? browserRegistry.byDigest(browserRegistry.defaultDigest())?.id;
      };
      if (!scopedBrowserAllowed) {
        response = rpcError(message.id, -32003, 'Run grant is bound to another browser');
      }
      else if (!toolDefinition) {
        audit.write({ tool, outcome: 'not_found', agentId: principal.id, browserId: null, commandId: null });
        response = rpcError(message.id, -32602, 'Unknown tool');
      }
      else if (!canUseTool(principal, tool, args)) {
        audit.write({ tool, outcome: 'capability_denied', agentId: principal.id, browserId: null, commandId: prebuiltCommand?.command?.id || null });
        response = rpcError(message.id, -32003, 'Agent capability denied');
      }
      else if (tool === 'edge_approval_wait') {
        const id = args.approvalId;
        let snapshot = null;
        try { if (typeof id === 'string' && id.trim()) snapshot = verifiedActions.get(id); } catch {}
        const owner = snapshot?.proposal.target.kind === 'single_click' && (snapshot.proposal.actor.agentId === principal.id
          || (principal.runId && snapshot.proposal.target.grantId === principal.runId));
        const browserId = snapshot && browserRegistry.byDigest(snapshot.proposal.target.browserId)?.id;
        if (!owner || !mayUseBrowser(principal, browserId)) {
          response = rpcResult(message.id, textResult({ error: { code: 'approval_not_found', message: 'Approval was not found.' } }, true, { code: 'approval_not_found' }));
        } else {
          const waitMs = Number.isInteger(args.waitMs) ? Math.max(0, Math.min(50000, args.waitMs)) : 45000;
          const until = Date.now() + waitMs;
          let outcome;
          do {
            expireClick(id);
            snapshot = verifiedActions.get(id);
            outcome = approvalOutcomes.get(id);
            if (outcome?.status !== 'pending' && outcome) break;
            if (snapshot.phase === 'rejected') { outcome = { status: snapshot.rejection?.approverId === 'system' ? 'expired' : 'declined' }; break; }
            if (['approved', 'executing'].includes(snapshot.phase) && !outcome && !pendingClicks.has(id)) {
              failLostClick(id, snapshot);
              outcome = approvalOutcomes.get(id);
              break;
            }
            if (snapshot.phase === 'verified') { outcome = { status: 'approved' }; break; }
            if (['failed', 'indeterminate'].includes(snapshot.phase)) {
              outcome = { status: 'failed', error: snapshot.receipt?.verification?.reason || snapshot.recovery?.reason || restartError };
              break;
            }
            if (Date.now() >= until) break;
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, until - Date.now())));
          } while (true);
          response = rpcResult(message.id, textResult(outcome?.status !== 'pending' && outcome
            ? outcome : { status: 'pending', approvalId: id, expiresAt: snapshot.proposal.target.expiresAt }));
          if (outcome && outcome.status !== 'pending') clearOutcome(id);
        }
      }
      else if (tool !== 'edge_list_browsers' && !mayUseBrowser(principal, privacyTarget())) {
        audit.write({ tool, outcome: 'private_browser', agentId: principal.id, browserId: args.browserId || null, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: 'private_browser', message: privateBrowserMessage } }, true, { code: 'private_browser' }));
      }
      else if (missingRequiredFields.length) {
        const result = textResult({ error: { code: 'validation_failed', message: `Missing required field${missingRequiredFields.length === 1 ? '' : 's'}: ${missingRequiredFields.join(', ')}` } }, true, { code: 'validation_failed' });
        audit.write({ tool, outcome: 'validation_failed', agentId: principal.id, browserId: null, commandId: prebuiltCommand?.command?.id || null });
        response = rpcResult(message.id, result);
      }
      else if (prebuiltCommand?.error) {
        const result = textResult({ error: { code: 'validation_failed', message: prebuiltCommand.error } }, true, { code: 'validation_failed', approvalRequired: true });
        audit.write({ tool, outcome: 'validation_failed', agentId: principal.id, browserId: null, commandId: prebuiltCommand?.command?.id || null });
        response = rpcResult(message.id, result);
      }
      else if (['navigate', 'open_tab'].includes(prebuiltCommand?.command?.type) && prebuiltCommand.command.url !== undefined && !allowedUrl(prebuiltCommand.command.url, policy)) {
        // Hardening gate (approved 2026-10-14): navigation honours the broker URL policy
        // before any browser is chosen, so blocked addresses never reach a browser.
        const result = textResult({ error: { code: 'policy_denied', message: 'That address is blocked by this server\'s browsing policy.' } }, true, { code: 'policy_denied' });
        audit.write({ tool, outcome: 'policy_denied', agentId: principal.id, browserId: null, commandId: prebuiltCommand.command.id || null });
        response = rpcResult(message.id, result);
      }
      else if (tool === 'edge_list_browsers') {
        audit.write({ tool, outcome: 'ok', agentId: principal.id, browserId: null, commandId: null });
        const browsers = visibleBrowsers(principal);
        response = rpcResult(message.id, textResult({ browsers, defaultBrowserId: browsers.some((browser) => browser.isDefault) ? browserRegistry.byDigest(browserRegistry.defaultDigest())?.id : null }));
      }
      else if (tool === 'edge_bridge_status') {
        const statusTarget = resolveBrowser(args);
        audit.write({ tool, outcome: statusTarget.ok ? 'ok' : statusTarget.code, agentId: principal.id, browserId: statusTarget.browser?.id || statusTarget.browserId || null, commandId: null });
        if (statusTarget.code === 'browser_unknown') {
          response = rpcResult(message.id, textResult({ error: { code: statusTarget.code, message: statusTarget.message } }, true, { code: statusTarget.code }));
        } else {
          const browserDigest = statusTarget.ok
            ? statusTarget.digest
            : statusTarget.code === 'browser_offline' && statusTarget.browserId
              ? browserRegistry.byId(statusTarget.browserId)
              : null;
          response = rpcResult(message.id, resultFor(tool, args, { policy, store, commandQueue, browserDigest, commandTransport: commandTransport(browserDigest), browsers: visibleBrowsers(principal), agentControl: agentControlLease.status({ browserId: browserDigest }) }));
        }
      }
      else if (tool === 'edge_verified_action_status') {
        const snapshot = verifiedActions.get(message.params?.arguments?.transactionId);
        const found = Boolean(snapshot && principalCanReadTransaction(principal, snapshot)
          && mayUseBrowser(principal, browserRegistry.byDigest(snapshot.proposal?.target?.browserId)?.id));
        const browserId = found ? browserRegistry.byDigest(snapshot.proposal?.target?.browserId)?.id || null : null;
        audit.write({ tool, outcome: found ? 'ok' : 'not_found', agentId: principal.id, browserId, commandId: null });
        response = rpcResult(message.id, found
          ? textResult(publicVerifiedAction(snapshot))
          : textResult({ error: { code: 'transaction_not_found', message: 'Verified action transaction was not found.' } }, true, { code: 'transaction_not_found' }));
      }
      else if (tool === 'edge_verified_receipt') {
        try {
          const receipt = receiptStore.get(message.params?.arguments?.transactionId);
          const transaction = receipt && verifiedActions.get(message.params?.arguments?.transactionId);
          const found = Boolean(receipt && principalOwnsReceipt(principal, receipt)
            && mayUseBrowser(principal, browserRegistry.byDigest(transaction?.proposal?.target?.browserId)?.id));
          let browserId = null;
          if (found) {
            try {
              const snapshot = verifiedActions.get(message.params?.arguments?.transactionId);
              browserId = browserRegistry.byDigest(snapshot?.proposal?.target?.browserId)?.id || null;
            } catch {}
          }
          const result = found
            ? textResult({ receipt, chain: receiptStore.verifyChain() })
            : textResult({ error: { code: 'receipt_not_found', message: 'Verified action receipt was not found.' } }, true, { code: 'receipt_not_found' });
          audit.write({ tool, outcome: found ? 'ok' : 'not_found', agentId: principal.id, browserId, commandId: null });
          response = rpcResult(message.id, result);
        } catch (error) {
          audit.write({ tool, outcome: 'not_found', agentId: principal.id, browserId: null, commandId: null });
          response = rpcResult(message.id, textResult({ error: { code: 'receipt_store_invalid', message: error.message } }, true, { code: 'receipt_store_invalid' }));
        }
      }
      else if (tool === 'edge_screenshot' && policy.capture?.screenshotEnabled !== true) {
        const result = textResult({ error: { code: 'screenshot_disabled', message: 'Screenshot capture is disabled by broker policy.' } }, true, { code: 'screenshot_disabled' });
        audit.write({ tool, outcome: 'denied_or_unavailable', agentId: principal.id, browserId: null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (!targetBrowser().ok && !(targetBrowser().code === 'browser_offline' && ['edge_active_tab', 'edge_snapshot', 'edge_extract_text', 'edge_list_tabs'].includes(tool))) {
        resolvedBrowser = targetBrowser();
        audit.write({ tool, outcome: resolvedBrowser.code, agentId: principal.id, browserId: resolvedBrowser.browserId || null, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: resolvedBrowser.code, message: resolvedBrowser.message, ...(resolvedBrowser.browserId ? { browserId: resolvedBrowser.browserId } : {}) } }, true, { code: resolvedBrowser.code }));
      }
      else if (resolvedBrowser.ok && TOOL_MINIMUMS[tool] && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, TOOL_MINIMUMS[tool])) {
        const have = commandTransport(resolvedBrowser.digest).extensionVersion;
        const outdated = outdatedExtension(resolvedBrowser.browser, have, tool, TOOL_MINIMUMS[tool]);
        audit.write({ tool, outcome: 'extension_outdated', agentId: principal.id, browserId: resolvedBrowser.browser.id, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: outdated.code, message: outdated.error } }, true, { code: outdated.code }));
      }
      else if (resolvedBrowser.ok && args.tabId !== undefined
        && ['edge_snapshot', 'edge_extract_text', 'edge_active_tab', 'edge_find_elements'].includes(tool)
        && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, PER_TAB_READ_MINIMUM)) {
        const have = commandTransport(resolvedBrowser.digest).extensionVersion;
        const outdated = outdatedExtension(resolvedBrowser.browser, have, tool, PER_TAB_READ_MINIMUM);
        audit.write({ tool, outcome: 'extension_outdated', agentId: principal.id, browserId: resolvedBrowser.browser.id, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: outdated.code, message: outdated.error } }, true, { code: outdated.code }));
      }
      else if (resolvedBrowser.ok && [args.ref, args.selector].some((value) => typeof value === 'string' && value.startsWith('fbb-frame:'))
        && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, FRAME_TARGET_MINIMUM)) {
        const have = commandTransport(resolvedBrowser.digest).extensionVersion;
        const outdated = outdatedExtension(resolvedBrowser.browser, have, tool, FRAME_TARGET_MINIMUM);
        audit.write({ tool, outcome: 'extension_outdated', agentId: principal.id, browserId: resolvedBrowser.browser.id, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: outdated.code, message: outdated.error } }, true, { code: outdated.code }));
      }
      else if (resolvedBrowser.ok && args.near !== undefined && ['edge_click', 'edge_press', 'edge_type', 'edge_select'].includes(tool)
        && !(prebuiltCommand?.command?.finalAction && resolvedBrowser.browser.askBeforeFinalActions !== false
          && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, APPROVAL_MINIMUM))
        && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, LOCATOR_MINIMUMS.near)) {
        const have = commandTransport(resolvedBrowser.digest).extensionVersion;
        const outdated = outdatedExtension(resolvedBrowser.browser, have, tool, LOCATOR_MINIMUMS.near);
        audit.write({ tool, outcome: 'extension_outdated', agentId: principal.id, browserId: resolvedBrowser.browser.id, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: outdated.code, message: outdated.error } }, true, { code: outdated.code }));
      }
      else if (resolvedBrowser.ok && ['edge_click', 'edge_press', 'edge_navigate'].includes(tool)
        && resolvedBrowser.browser.askBeforeFinalActions !== false
        && prebuiltCommand?.command?.finalAction
        && isOlderExtension(commandTransport(resolvedBrowser.digest).extensionVersion, APPROVAL_MINIMUM)) {
        const have = commandTransport(resolvedBrowser.digest).extensionVersion;
        const outdated = outdatedExtension(resolvedBrowser.browser, have, tool, APPROVAL_MINIMUM);
        audit.write({ tool, outcome: 'extension_outdated', agentId: principal.id, browserId: resolvedBrowser.browser.id, commandId: null });
        response = rpcResult(message.id, textResult({ error: { code: outdated.code, message: outdated.error } }, true, { code: outdated.code }));
      }
      else if (toolDefinition.annotations?.readOnlyHint === false && (() => {
        try { handoffLease.assertAgentMayMutate(resolvedBrowser.digest); return false; }
        catch { return true; }
      })()) {
        audit.write({ tool, outcome: 'human_takeover_active', agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: prebuiltCommand?.command?.id || null });
        response = rpcResult(message.id, textResult({ error: { code: 'human_takeover_active', message: 'A human controller currently owns this browser.' } }, true, { code: 'human_takeover_active' }));
      }
      else if (toolDefinition.annotations?.readOnlyHint === false && (() => {
        const lock = agentControlLease.acquire({ browserId: resolvedBrowser.digest, agentId: principal.id });
        if (lock.granted) return false;
        audit.write({ tool, outcome: 'agent_control_busy', agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: prebuiltCommand?.command?.id || null });
        const seconds = Math.ceil(lock.retryAfterMs / 1000);
        response = rpcResult(message.id, textResult({ error: { code: 'agent_control_busy', message: `Another agent (${lock.holder}) is acting on this browser. Try again in ${seconds} seconds.`, holder: lock.holder, retryAfterMs: lock.retryAfterMs } }, true, { code: 'agent_control_busy' }));
        return true;
      })()) { /* response already set */ }
      else if (tool === 'edge_verified_action_inspect') {
        const snapshot = store.latest(resolvedBrowser.digest);
        let result;
        if (!snapshot || !allowedUrl(snapshot.url, policy)) {
          result = textResult({ error: { code: 'no_approved_capture', message: 'An approved active-tab capture is required before inspecting fields.' } }, true, { code: 'no_approved_capture' });
        } else {
          try {
            const steps = verifiedSteps(message.params?.arguments?.changes);
            const commit = verifiedLocator(message.params?.arguments?.commit, 'commit');
            const timeoutMs = boundedTimeout(message.params?.arguments?.timeoutMs);
            const browserResult = await dispatchBrowserCommand({ id: randomBytes(8).toString('hex'), type: 'verified_preflight', steps, createdAt: new Date().toISOString() }, timeoutMs, resolvedBrowser.digest, principal.id);
            if (!browserResult.ok) {
              result = textResult({ error: { code: browserResult.code || 'browser_denied', message: browserResult.error || 'The browser refused field inspection.' } }, true, { code: browserResult.code || 'browser_denied' });
            } else if (!Number.isInteger(browserResult.result?.tabId) || !allowedUrl(browserResult.result?.origin, policy)) {
              result = textResult({ error: { code: 'inspection_context_invalid', message: 'The browser inspection context is incomplete or outside policy.' } }, true, { code: 'inspection_context_invalid' });
            } else {
              const inspectionId = randomBytes(16).toString('hex');
              const now = Date.now();
              for (const [key, value] of verifiedInspections) if (value.expiresAt <= now) verifiedInspections.delete(key);
              verifiedInspections.set(inspectionId, {
                browserId: resolvedBrowser.digest,
                beforeHash: browserResult.result.currentBeforeHash,
                tabId: browserResult.result.tabId,
                tabIdHash: tokenDigest(String(browserResult.result.tabId)),
                origin: displayUrl(browserResult.result.origin, policy),
                steps,
                commit,
                expiresAt: now + 2 * 60_000
              });
              result = textResult({ ok: true, inspectionId, beforeHash: browserResult.result.currentBeforeHash, fields: browserResult.result.fields, origin: displayUrl(browserResult.result.origin, policy), expiresAt: new Date(now + 2 * 60_000).toISOString() });
            }
          } catch (error) {
            result = textResult({ error: { code: 'invalid_inspection', message: error.message } }, true, { code: 'invalid_inspection' });
          }
        }
        audit.write({ tool, outcome: result.isError ? 'denied_or_unavailable' : 'inspected', snapshot, agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (tool === 'edge_verified_action_propose') {
        const snapshot = store.latest(resolvedBrowser.digest);
        const transport = commandTransport(resolvedBrowser.digest);
        let result;
        if (!snapshot || !allowedUrl(snapshot.url, policy)) {
          result = textResult({ error: { code: 'no_approved_capture', message: 'An approved active-tab capture is required before proposing an action.' } }, true, { code: 'no_approved_capture' });
        } else if (!transport.healthy) {
          result = textResult({ error: { code: 'no_online_browser', message: 'A paired browser command transport is required before proposing an action.' } }, true, { code: 'no_online_browser' });
        } else {
          try {
            const args = message.params?.arguments || {};
            const inspection = typeof args.inspectionId === 'string' ? verifiedInspections.get(args.inspectionId) : null;
            if (!inspection || inspection.expiresAt <= Date.now()) throw new Error('Inspection is missing or expired. Inspect the fields again.');
            if (inspection.browserId !== resolvedBrowser.digest) throw new Error('Inspection belongs to a different browser.');
            verifiedInspections.delete(args.inspectionId);
            const proposed = verifiedActions.propose({
              browserId: resolvedBrowser.digest,
              intent: args.intent,
              actor: { agentId: principal.id },
              target: {
                origin: inspection.origin,
                tabId: inspection.tabId,
                tabIdHash: inspection.tabIdHash,
                inspectionHash: sha256({ beforeHash: inspection.beforeHash, steps: inspection.steps, commit: inspection.commit }),
                operation: { steps: inspection.steps, commit: inspection.commit },
                ...(args.recordIdHash ? { recordIdHash: args.recordIdHash } : {})
              },
              beforeHash: inspection.beforeHash,
              changes: inspection.steps.map(({ field, to }) => ({ field, to }))
            });
            result = textResult({
              ok: true,
              approvalRequired: true,
              transaction: publicVerifiedAction(proposed),
              next: 'The paired browser must approve or reject this exact proposal.'
            }, false, { approvalRequired: true });
          } catch (error) {
            result = textResult({ error: { code: 'invalid_proposal', message: error.message } }, true, { code: 'invalid_proposal' });
          }
        }
        audit.write({ tool, outcome: result.isError ? 'denied_or_unavailable' : 'proposed', snapshot, agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (tool === 'edge_verified_action_reconcile') {
        const id = message.params?.arguments?.transactionId;
        const transaction = typeof id === 'string' ? verifiedActions.get(id) : null;
        let result;
        if (!transaction) {
          result = textResult({ error: { code: 'transaction_not_found', message: 'Verified action transaction was not found.' } }, true, { code: 'transaction_not_found' });
        } else if (!principalOwnsTransaction(principal, transaction)) {
          result = textResult({ error: { code: 'transaction_not_found', message: 'Verified action transaction was not found.' } }, true, { code: 'transaction_not_found' });
        } else if (transaction.phase !== 'indeterminate') {
          result = textResult({ error: { code: 'transaction_not_indeterminate', message: `Verified action is ${transaction.phase}, not indeterminate.` } }, true, { code: 'transaction_not_indeterminate' });
        } else if (transaction.proposal.target.browserId !== resolvedBrowser.digest) {
          result = textResult({ error: { code: 'wrong_browser', message: 'The browser bound to this action is not the active reconciliation browser.' } }, true, { code: 'wrong_browser' });
        } else {
          const boundBrowserId = transaction.proposal.target.browserId;
          const timeoutMs = boundedTimeout(message.params?.arguments?.timeoutMs);
          const operation = transaction.proposal.target.operation;
          const readback = await dispatchBrowserCommand({
            id: randomBytes(8).toString('hex'),
            type: 'verified_verify',
            steps: operation.steps,
            expectedTabId: transaction.proposal.target.tabId,
            expectedOrigin: transaction.proposal.target.origin,
            proposalHash: transaction.proposalHash,
            approval: transaction.approval,
            createdAt: new Date().toISOString()
          }, timeoutMs, boundBrowserId, principal.id);
          if (!readback.ok) {
            result = textResult({ error: { code: 'reconciliation_unavailable', message: readback.error || 'Read-only reconciliation could not be completed.', transaction: publicVerifiedAction(transaction) } }, true, { code: 'reconciliation_unavailable' });
          } else if (!Number.isInteger(readback.result?.tabId) || tokenDigest(String(readback.result.tabId)) !== transaction.proposal.target.tabIdHash || displayUrl(readback.result?.origin, policy) !== transaction.proposal.target.origin) {
            result = textResult({ error: { code: 'target_context_changed', message: 'The active browser tab no longer matches the indeterminate action target.' } }, true, { code: 'target_context_changed' });
          } else {
            try {
              const reconciled = verifiedActions.verify(id, {
                browserId: boundBrowserId,
                after: readback.result.persistedChanges,
                persistedChanges: readback.result.persistedChanges,
                method: `reconciliation:${readback.result.method || 'structured-state'}`
              });
              result = textResult({ ok: reconciled.phase === 'verified', reconciled: true, transaction: publicVerifiedAction(reconciled) }, reconciled.phase !== 'verified', { code: reconciled.phase === 'verified' ? 'verified' : 'persisted_mismatch' });
            } catch (error) {
              result = textResult({ error: { code: 'reconciliation_failed', message: error.message } }, true, { code: 'reconciliation_failed' });
            }
          }
        }
        audit.write({ tool, outcome: result.isError ? 'unresolved_or_mismatch' : 'verified', agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (tool === 'edge_verified_action_execute') {
        const id = message.params?.arguments?.transactionId;
        const transaction = typeof id === 'string' ? verifiedActions.get(id) : null;
        let result;
        if (!transaction) {
          result = textResult({ error: { code: 'transaction_not_found', message: 'Verified action transaction was not found.' } }, true, { code: 'transaction_not_found' });
        } else if (!principalOwnsTransaction(principal, transaction)) {
          result = textResult({ error: { code: 'transaction_not_found', message: 'Verified action transaction was not found.' } }, true, { code: 'transaction_not_found' });
        } else if (transaction.phase !== 'approved') {
          result = textResult({ error: { code: 'transaction_not_approved', message: `Verified action is ${transaction.phase}, not approved.` } }, true, { code: 'transaction_not_approved', approvalRequired: true });
        } else if (transaction.proposal.target.browserId !== resolvedBrowser.digest) {
          result = textResult({ error: { code: 'wrong_browser', message: 'The browser that approved this action is not the active execution browser.' } }, true, { code: 'wrong_browser' });
        } else {
          const boundBrowserId = transaction.proposal.target.browserId;
          const timeoutMs = boundedTimeout(message.params?.arguments?.timeoutMs);
          const operation = transaction.proposal.target.operation;
          const baseCommand = {
            steps: operation.steps,
            expectedTabId: transaction.proposal.target.tabId,
            expectedOrigin: transaction.proposal.target.origin,
            createdAt: new Date().toISOString()
          };
          const preflight = await dispatchBrowserCommand({ ...baseCommand, id: randomBytes(8).toString('hex'), type: 'verified_preflight' }, timeoutMs, boundBrowserId, principal.id);
          if (!preflight.ok) {
            result = textResult({ error: { code: preflight.code || 'preflight_failed', message: preflight.error || 'Verified preflight failed.' } }, true, { code: preflight.code || 'preflight_failed' });
          } else if (!Number.isInteger(preflight.result?.tabId) || tokenDigest(String(preflight.result.tabId)) !== transaction.proposal.target.tabIdHash || displayUrl(preflight.result?.origin, policy) !== transaction.proposal.target.origin) {
            result = textResult({ error: { code: 'target_context_changed', message: 'The active browser tab no longer matches the approved target.' } }, true, { code: 'target_context_changed' });
          } else {
            try {
              verifiedActions.beginExecution(id, {
                browserId: boundBrowserId,
                proposal: transaction.proposal,
                currentBeforeHash: preflight.result.currentBeforeHash
              });
              const applied = await dispatchBrowserCommand({
                ...baseCommand,
                id: randomBytes(8).toString('hex'),
                type: 'verified_apply',
                proposalHash: transaction.proposalHash,
                approval: transaction.approval,
                expectedBeforeHash: transaction.proposal.beforeHash,
                commit: operation.commit
              }, timeoutMs, boundBrowserId, principal.id);
              if (!applied.ok) {
                const definitelyNotDispatched = ['no_online_browser', 'wrong_browser', 'command_store_unavailable'].includes(applied.code);
                if (definitelyNotDispatched) {
                  const failed = verifiedActions.failExecution(id, { browserId: boundBrowserId, reason: applied.error || 'Verified browser execution was not dispatched.' });
                  result = textResult({ error: { code: applied.code, message: applied.error || 'Verified browser execution was not dispatched.', transaction: publicVerifiedAction(failed) } }, true, { code: applied.code });
                } else {
                  const uncertain = verifiedActions.markIndeterminate(id, { browserId: boundBrowserId, reason: applied.error || 'The browser did not provide an authoritative execution outcome.' });
                  result = textResult({ error: { code: 'execution_indeterminate', message: 'The action may have committed. Reconcile it; do not replay it.', transaction: publicVerifiedAction(uncertain) } }, true, { code: 'execution_indeterminate' });
                }
              } else {
                const readback = await dispatchBrowserCommand({
                  ...baseCommand,
                  id: randomBytes(8).toString('hex'),
                  type: 'verified_verify',
                  proposalHash: transaction.proposalHash,
                  approval: transaction.approval
                }, timeoutMs, boundBrowserId, principal.id);
                if (!readback.ok) {
                  const uncertain = verifiedActions.markIndeterminate(id, { browserId: boundBrowserId, reason: readback.error || 'The commit was acknowledged but post-commit verification was unavailable.' });
                  result = textResult({ error: { code: 'execution_indeterminate', message: 'The commit was acknowledged but persistence is unverified. Reconcile it; do not replay it.', transaction: publicVerifiedAction(uncertain) } }, true, { code: 'execution_indeterminate' });
                } else {
                  const verified = verifiedActions.verify(id, {
                    browserId: boundBrowserId,
                    after: readback.result.persistedChanges,
                    persistedChanges: readback.result.persistedChanges,
                    method: readback.result.method
                  });
                  result = textResult({ ok: verified.phase === 'verified', transaction: publicVerifiedAction(verified) }, verified.phase !== 'verified', { code: verified.phase === 'verified' ? 'verified' : 'persisted_mismatch' });
                }
              }
            } catch (error) {
              result = textResult({ error: { code: 'verification_failed', message: error.message } }, true, { code: 'verification_failed' });
            }
          }
        }
        audit.write({ tool, outcome: result.isError ? 'failed' : 'verified', agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (tool === 'edge_screenshot') {
        const transport = commandTransport(resolvedBrowser.digest);
        let result;
        if (!transport.healthy) {
          result = textResult({ error: { code: 'no_online_browser', message: transport.failureReason ? `No paired browser has a usable command transport: ${transport.failureReason}.` : 'No paired browser has a usable command transport.' } }, true, { code: 'no_online_browser' });
        } else if (!isVersionAtLeast(transport.extensionVersion, MIN_SCREENSHOT_EXTENSION_VERSION)) {
          result = textResult({ error: { code: 'browser_upgrade_required', message: `Screenshot capture requires extension ${MIN_SCREENSHOT_EXTENSION_VERSION} or newer; the active browser reports ${transport.extensionVersion || 'unknown'}.` } }, true, { code: 'browser_upgrade_required' });
        } else {
          const boundBrowserId = resolvedBrowser.digest;
          const timeoutMs = boundedTimeout(message.params?.arguments?.timeoutMs);
          const built = buildCommand(tool, message.params?.arguments || {});
          const browserResult = built.error ? { ok: false, code: 'validation_failed', error: built.error } : await dispatchBrowserCommand(built.command, timeoutMs, boundBrowserId, principal.id);
          if (!browserResult.ok) {
            result = textResult({ error: { code: browserResult.code || 'browser_denied', message: browserResult.error || 'The browser refused screenshot capture.' } }, true, { code: browserResult.code || 'browser_denied' });
          } else {
            const screenshot = store.takeScreenshot(boundBrowserId, built.command.id);
            if (!screenshot) result = textResult({ error: { code: 'screenshot_not_stored', message: 'The browser reported success but no matching screenshot was stored.' } }, true, { code: 'screenshot_not_stored' });
            else if (screenshot.tabId !== browserResult.result?.tabId) result = textResult({ error: { code: 'screenshot_context_mismatch', message: 'The stored screenshot does not match the browser result context.' } }, true, { code: 'screenshot_context_mismatch' });
            else result = { content: [{ type: 'image', data: screenshot.data, mimeType: 'image/png' }], _meta: { browserId: resolvedBrowser.browser.id, capturedAt: screenshot.capturedAt, rawScreen: true } };
          }
        }
        audit.write({ tool, outcome: result.isError ? 'denied_or_unavailable' : 'ok', snapshot: store.latest(resolvedBrowser.digest), agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null });
        response = rpcResult(message.id, result);
      }
      else if (!tool.startsWith('edge_') || !BROWSER_COMMAND_TOOLS.includes(tool) && !(tool === 'edge_find_elements' && message.params?.arguments?.scope === 'live')) {
        const digest = resolvedBrowser.ok ? resolvedBrowser.digest : browserRegistry.byId(resolvedBrowser.browserId);
        const refreshable = ['edge_active_tab', 'edge_snapshot', 'edge_extract_text', 'edge_list_tabs'].includes(tool);
        const fresh = refreshable && resolvedBrowser.ok ? await freshRead(digest, principal.id, args.tabId) : false;
        const result = resultFor(tool, args, { policy, store, commandQueue, browserDigest: digest, commandTransport: commandTransport(digest), stale: refreshable && !fresh });
        if (!result.isError && SNAPSHOT_READ_TOOLS.has(tool)) {
          const seen = store.latest(digest, args.tabId);
          if (seen) seenPages.record(principal.id, digest, seen.tabId, seen.url);
        }
        audit.write({ tool, outcome: result.isError ? 'denied_or_unavailable' : 'ok', snapshot: store.latest(resolvedBrowser.digest), agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: null }); response = rpcResult(message.id, result);
      } else {
        const built = prebuiltCommand || buildCommand(tool, args);
        let result;
        if (built.error) result = textResult({ error: { code: 'validation_failed', message: built.error } }, true, { code: 'validation_failed', approvalRequired: true });
        else if (!commandTransport(resolvedBrowser.digest).healthy) {
          const transport = commandTransport(resolvedBrowser.digest);
          const message = transport.failureReason
            ? `No paired browser has a usable command transport: ${transport.failureReason}.`
            : 'No paired browser has a usable command transport.';
          result = textResult({ error: { code: 'no_online_browser', message } }, true, { code: 'no_online_browser', approvalRequired: true });
        }
        else {
          const token = resolvedBrowser.digest;
          const timeoutMs = boundedTimeout(message.params?.arguments?.timeoutMs);
          try {
            const seenForCommand = LOOK_FIRST_TOOLS.has(tool) ? { seenPages: seenPages.forAgent(principal.id, token) } : {};
            const askBeforeFinalActions = resolvedBrowser.browser.askBeforeFinalActions !== false;
            let approvalBinding = null;
            let clickTransaction = null;
            const actorLabel = approvalActorLabel(principal, args.actorLabel);
            let approvedCommand = { ...built.command, agentId: principal.id, ...seenForCommand, askBeforeFinalActions };
            if (askBeforeFinalActions && !isOlderExtension(commandTransport(token).extensionVersion, APPROVAL_MINIMUM)
              && (['click', 'press'].includes(built.command.type) || (['navigate', 'open_tab'].includes(built.command.type) && built.command.finalAction))) {
              const transactionId = `click-${randomBytes(12).toString('hex')}`;
              const approvalToken = randomBytes(24).toString('hex');
              const inspectionCommand = { ...approvedCommand };
              delete inspectionCommand.seenPages;
              const inspected = await dispatchBrowserCommand({ ...inspectionCommand, id: randomBytes(8).toString('hex'), type: 'inspect_action', approvalToken, transactionId,
                approvalExpiresAt: Date.now() + approvalWaitMs + 10_000, finalNavigation: ['navigate', 'open_tab'].includes(built.command.type) }, timeoutMs, token, principal.id);
              if (inspected.result?.page) seenPages.recordPage(principal.id, token, inspected.result.page);
              if (!inspected.ok && inspected.code === 'look_first') {
                result = textResult({ error: { code: 'look_first', message: inspected.error || 'Read the page again before acting.',
                  page: inspected.result?.page || null, capture: inspected.result?.capture || null } }, true, { code: 'look_first' });
              } else if (!inspected.ok && inspected.code === 'ambiguous_target') {
                result = textResult({ error: { code: 'ambiguous_target', message: inspected.error, candidates: inspected.candidates || inspected.result?.candidates || [] } }, true, { code: 'ambiguous_target' });
              } else if (!inspected.ok) throw new BrowserInspectionError(inspected.error || 'The browser could not inspect the target.');
              else if (inspected.result?.finalAction || built.command.finalAction) {
                const target = inspected.result;
                if (target.ref && built.command.target) approvedCommand = { ...approvedCommand, target: { ref: target.ref } };
                const expiresAt = new Date(Date.now() + approvalWaitMs).toISOString();
                const actionName = String(target.name || '');
                const actionVerb = ['navigate', 'open_tab'].includes(built.command.type) ? 'open' : 'click';
                clickTransaction = verifiedActions.propose({
                  id: transactionId, browserId: token,
                  intent: `${actorLabel || principal.name || principal.label || principal.id} wants to ${actionVerb} "${actionName.slice(0, 200)}" on ${target.context ? `"${target.context}" (${target.title || target.url})` : target.title || target.url}`,
                  actor: { agentId: principal.id, displayLabel: actorLabel || principal.name || principal.label || principal.id },
                  target: { kind: 'single_click', operation: { commit: approvedCommand.target || { targetText: actionName } }, tabId: target.tabId,
                    origin: new URL(target.url).origin, url: target.url, title: target.title, fingerprint: target.fingerprint,
                    name: actionName, context: String(target.context || '').slice(0, 80), requestedUrl: built.command.url || null, grantId: principal.runId || null, expiresAt },
                  beforeHash: sha256({ fingerprint: target.fingerprint, name: actionName, url: target.url }),
                  changes: [{ field: 'Action', to: actionName }]
                });
                pendingClicks.set(transactionId, { token, command: approvedCommand, target, approvalToken, transaction: clickTransaction, timeoutMs, agentId: principal.id });
                const expiry = setTimeout(() => expireClick(transactionId), approvalWaitMs + 1);
                expiry.unref?.();
                expiryTimers.set(transactionId, expiry);
                result = textResult({ ok: false, code: 'approval_pending', approvalId: transactionId, expiresAt, context: String(target.context || '').slice(0, 80),
                  message: `Waiting for the owner to approve "${actionName}" (up to 2 minutes). Call edge_approval_wait with this approvalId to get the result.` }, true, { code: 'approval_pending' });
              }
            }
            if (!result) {
              commandQueue.enqueue(token, approvedCommand, timeoutMs);
              const browserResult = await commandQueue.waitForResult(token, built.command.id, timeoutMs);
              let receiptProblem = null;
              if (approvalBinding) {
                try {
                  if (browserResult?.ok) verifiedActions.verify(approvalBinding.transactionId, { browserId: token, after: browserResult.result,
                    persistedChanges: [{ field: 'Action', to: clickTransaction.proposal.target.name }], method: 'browser-command-result' });
                  else verifiedActions.failExecution(approvalBinding.transactionId, { browserId: token, reason: browserResult?.error || 'The browser did not confirm the click.' });
                } catch (error) {
                  receiptProblem = error;
                  if (browserResult?.ok) {
                    try { verifiedActions.markIndeterminate(approvalBinding.transactionId, { browserId: token, reason: 'The click ran but its receipt could not be stored.' }); }
                    catch { /* Preserve the browser's confirmed outcome. */ }
                  }
                }
              }
              if (browserResult?.result?.page) seenPages.recordPage(principal.id, token, browserResult.result.page);
              if (!browserResult) result = textResult({ error: { code: 'command_timeout', message: 'The browser did not confirm the command before its timeout.' } }, true, { code: 'command_timeout', approvalRequired: true });
              else if (browserResult.code === 'transport_unhealthy') result = textResult({ error: { code: 'transport_unhealthy', message: 'The browser command transport did not acknowledge delivery.' } }, true, { code: 'transport_unhealthy', approvalRequired: true });
              else if (browserResult.code === 'agent_revoked') result = textResult({ error: { code: 'agent_revoked', message: browserResult.error } }, true, { code: 'agent_revoked' });
              else if (browserResult.code === 'look_first') result = textResult({ error: { code: 'look_first', message: browserResult.error || 'Read the page again before acting.', page: browserResult.result?.page || null, capture: browserResult.result?.capture || null } }, true, { code: 'look_first' });
              else if (!browserResult.ok) {
                const code = BROWSER_RESULT_CODES.has(browserResult.code) ? browserResult.code : 'browser_denied';
                result = textResult({ error: { code, message: browserResult.error || 'The browser refused this command.', ...(code === 'ambiguous_target' ? { candidates: browserResult.candidates || browserResult.result?.candidates || [] } : {}) } }, true, { code, approvalRequired: code === 'browser_denied' });
              }
              else if (tool === 'edge_read_tab' && typeof browserResult.result?.capture?.text === 'string') {
                const limit = Math.min(args.maxCharacters || policy.capture.maxTextCharacters, policy.capture.maxTextCharacters);
                result = textResult({ ok: true, result: { ...browserResult.result, capture: { ...browserResult.result.capture, text: browserResult.result.capture.text.slice(0, limit), truncated: browserResult.result.capture.truncated === true || browserResult.result.capture.text.length > limit } } });
              }
              else result = textResult({ ok: true, result: browserResult.result });
              if (approvalBinding && !result.isError) result = textResult({ ok: true, result: browserResult.result, approved: true,
                ...(receiptProblem ? { receiptPending: true, warning: 'The click ran, but its receipt could not be stored.' } : {}) });
            }
          } catch (error) {
            result = error instanceof BrowserInspectionError
              ? textResult({ error: { code: 'browser_denied', message: error.message } }, true, { code: 'browser_denied' })
              : textResult({ error: { code: 'command_store_unavailable', message: 'The browser command could not be persisted.' } }, true, { code: 'command_store_unavailable', approvalRequired: true });
          }
        }
        audit.write({ tool, outcome: result.isError ? 'denied_or_unavailable' : 'ok', snapshot: tool === 'edge_navigate' ? { url: args.url } : undefined, agentId: principal.id, browserId: resolvedBrowser?.browser?.id || null, commandId: built.command?.id || null });
        response = rpcResult(message.id, result);
      }
    }
    else response = rpcError(message.id, -32601, 'Method not found');
    if (principal.source === 'run-grant' && message.method === 'tools/call' && response) {
      const browserDigest = browserRegistry.byId(principal.browserId);
      const privateRead = browserRegistry.byDigest(browserDigest)?.private === true && response.result?.isError !== true && response.result?.content?.some((item) => item.type === 'text');
      const review = privateRead ? readReview(response.result) : null;
      let cancelledRead = false;
      if (review) {
        const id = `read-${randomBytes(12).toString('hex')}`;
        const expiresAt = new Date(Date.now() + approvalWaitMs).toISOString();
        const card = { phase: 'proposed', privateBrowser: true, proposalHash: sha256({ id, runId: principal.runId, review }), proposal: {
          transactionId: id, intent: `Send scrubbed page to ${principal.lane}? ${review.label}`, actor: { agentId: principal.id },
          target: { kind: 'single_click', readReview: true, grantId: principal.runId, browserId: principal.browserId, expiresAt, name: 'Send scrubbed page' },
          changes: [{ field: 'Scrubbed details', to: review.label }], createdAt: new Date().toISOString() } };
        const allowed = await new Promise((resolve) => {
          const timer = setTimeout(() => { pendingReads.delete(id); resolve(false); }, approvalWaitMs);
          timer.unref?.();
          pendingReads.set(id, { browserDigest, card, timer, resolve });
        });
        if (!allowed) { response = rpcResult(message.id, textResult({ ok: false, error: 'User cancelled sending this page' }, true)); cancelledRead = true; }
      }
      if (!cancelledRead && !res.destroyed && !req.aborted) {
        const bytes = JSON.stringify(response);
        try { await cloudReceived.append(principal.runId, { at: new Date().toISOString(), tool: message.params.name, bytes }); }
        catch { return send(res, 503, rpcError(message.id, -32002, 'Cloud-received log is unavailable')); }
        return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(bytes);
      }
    }
    if (res.destroyed || req.aborted) return;
    return send(res, 200, response);
  });
  const failUnacknowledgedDelivery = (browserId, socket, id) => {
    const pending = deliveryAcks.get(id);
    if (!pending || pending.socket !== socket) return;
    clearDeliveryAck(id);
    socketUnavailable(browserId, socket);
    commandQueue.submitResult(browserId, id, { ok: false, code: 'transport_unhealthy', error: 'Command delivery was not acknowledged by the browser.' });
    socket.destroy();
  };
  const deliver = (browserId, socket, lastReceivedSeq = 0, lastCompletedSeq = 0) => {
    const delivery = commandQueue.nextForBrowser(browserId, lastReceivedSeq, lastCompletedSeq);
    if (!delivery) return true;
    if (!websocketSend(socket, { type: 'command', seq: delivery.seq, command: delivery.command })) { socketUnavailable(browserId, socket); return false; }
    clearDeliveryAck(delivery.command.id);
    deliveryAcks.set(delivery.command.id, { socket, timer: setTimeout(() => failUnacknowledgedDelivery(browserId, socket, delivery.command.id), ackTimeout) });
    return true;
  };
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/work-edge/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof req.headers['sec-websocket-key'] !== 'string') { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    socket.setKeepAlive(true, 10_000);
    socket.setNoDelay(true);
    socket.isAlive = true;
    let browserId = null;
    socket.setTimeout(10_000);
    socket.on('timeout', () => { socketUnavailable(browserId, socket); socket.destroy(); });
    const authenticate = (message) => {
      if (!message || message.type !== 'hello' || typeof message.token !== 'string' || !tokenStore.matches(message.token)) { socket.destroy(); return; }
      if (!isSupportedExtensionVersion(typeof message.extensionVersion === 'string' ? message.extensionVersion : null)) {
        const key = tokenDigest(message.token);
        const now = Date.now();
        if (now - (lastRefusalAt.get(key) || 0) >= REFUSAL_COOLDOWN_MS) {
          console.warn(`[work-edge] version gate: refusing browser ${message.extensionVersion || 'unknown'} (min ${MIN_SUPPORTED_EXTENSION_VERSION})`);
          lastRefusalAt.set(key, now);
        }
        websocketSend(socket, { type: 'hello', ok: false, error: `Extension version ${message.extensionVersion || 'unknown'} is below the minimum supported version ${MIN_SUPPORTED_EXTENSION_VERSION}.` });
        socket.destroy();
        return;
      }
      browserId = tokenDigest(message.token);
      acceptSwap(browserId, message.swap);
      socket.setTimeout(30_000);
      const browser = browserRegistry.ensure(browserId);
      socket.publicBrowserId = browser.id;
      if (!websocketSend(socket, { type: 'hello', ok: true, browser })) { socketUnavailable(browserId, socket); socket.destroy(); return; }
      const previousSocket = liveSockets.get(browserId);
      if (previousSocket && previousSocket !== socket) {
        socketUnavailable(browserId, previousSocket);
        previousSocket.destroy();
      }
      liveSockets.set(browserId, socket);
      commandQueue.markOnline(browserId, message.controlEnabled, message.extensionVersion, message.runnerDiagnostic);
      deliver(browserId, socket, message.lastReceivedSeq, message.lastCompletedSeq);
    };
    websocketMessages(socket, (message) => {
      if (!browserId) return authenticate(message);
      socket.setTimeout(30_000);
      if (message.type === 'keepalive') { acceptSwap(browserId, message.swap); commandQueue.markOnline(browserId, message.controlEnabled, undefined, message.runnerDiagnostic); websocketSend(socket, { type: 'keepalive', ok: true, browser: browserRegistry.byDigest(browserId) }); return; }
      if (message.type === 'control-state' && typeof message.enabled === 'boolean') { commandQueue.markOnline(browserId, message.enabled); return; }
      if (message.type === 'command-received' && typeof message.id === 'string') { clearDeliveryAck(message.id); commandQueue.markOnline(browserId); return; }

      if (message.type === 'result' && typeof message.id === 'string' && typeof message.ok === 'boolean') { clearDeliveryAck(message.id); commandQueue.submitResult(browserId, message.id, { ok: message.ok, result: message.result, error: typeof message.error === 'string' ? message.error.slice(0, 1000) : undefined, code: BROWSER_RESULT_CODES.has(message.code) ? message.code : undefined }); deliver(browserId, socket, message.lastReceivedSeq, message.lastCompletedSeq); }
    }, (payload) => {
      socketUnavailable(browserId, socket);
      websocketClose(socket, payload);
    });
    const unavailable = () => socketUnavailable(browserId, socket);
    socket.on('end', () => { unavailable(); socket.destroy(); });
    socket.on('close', unavailable);
    socket.on('error', unavailable);
  });
  // MCP commands are pushed immediately to an authenticated live socket. The
  // persisted queue remains authoritative; HTTPS polling is recovery only.
  const originalEnqueue = commandQueue.enqueue.bind(commandQueue);
  commandQueue.enqueue = (browserId, command, timeoutMs) => { const pollingWillReceive = commandQueue.hasActivePollingWaiter(browserId); const record = originalEnqueue(browserId, command, timeoutMs); if (pollingWillReceive) return record; const socket = liveSockets.get(browserId); if (!socket || socket.destroyed || !deliver(browserId, socket)) commandQueue.markOffline(browserId); return record; };
  const heartbeat = setHeartbeatInterval(() => {
    runGrants.prune();
    for (const [browserId, socket] of liveSockets) {
      if (!tokenStore.read().tokenHashes.includes(browserId)) {
        socketUnavailable(browserId, socket);
        const commandOutcome = commandQueue.cancelPendingForBrowser(browserId);
        audit.write({ event: 'browser_revoked', tool: 'browser_revoked', outcome: 'revoked', browserId: socket.publicBrowserId, ...commandOutcome });
        socket.destroy();
        continue;
      }
      if (socket.isAlive === false || socket.destroyed) { socketUnavailable(browserId, socket); socket.destroy(); continue; }
      socket.isAlive = false;
      try { socket.write(Buffer.from([0x89, 0x00])); } catch { socketUnavailable(browserId, socket); socket.destroy(); }
    }
  }, 15_000);
  heartbeat.unref?.();
  server.once('close', () => clearInterval(heartbeat));
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;
  return server;
}

export function listenServer(server, policy, onListening) { validatePolicy(policy); return server.listen(policy.listen.port, policy.listen.host, onListening); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = prepareStartupEnv();
  const policy = loadPolicy(env);
  listenServer(createServer({ policy, env }), policy, () => {
    console.log(`Field Browser Bridge on http://${policy.listen.host}:${policy.listen.port}/mcp`);
    if (env.FBB_IN_CONTAINER === '1') console.log('Run `npm run owner-token` inside the broker container to retrieve the owner token.');
  });
}
export { CaptureStore };
