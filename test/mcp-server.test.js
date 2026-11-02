import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedUrl, CaptureStore, createServer, displayUrl, listenServer, normalizeCapture, PairedTokenStore, PairingService, validatePolicy } from '../broker/src/server.js';
import { HOSTED_INGEST_URL } from '../extension/hosted-default.js';
import { activeTabMetadata, autoCaptureEligibility, controlHeartbeatState, ensureDurableCommandRunner, executeCommandInActiveTab, isApprovedOrigin, isCapturableUrl, isFreshCaptureForTab, isSensitivePage, normalizeApprovedOrigins, normalizeBrokerUrl, runnerDiagnostic, screenshotActiveTab, validateBrokerUrl } from '../extension/service-worker.js';
import { BrowserCommandQueue, buildCommand } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { executeBrowserCommand } from '../extension/command-executor.js';
import { ACTION_TOOLS, READ_ONLY_TOOLS } from '../broker/src/tools.js';

const policy = {
  listen: { host: '127.0.0.1', port: 8765 },
  allowOrigins: ['https://approved.example'],
  denyUrlPrefixes: ['edge://', 'chrome://', 'file://', 'about:', 'https://approved.example/login'],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false }
};

test('broker retains a 60k capture and its text length metadata', () => {
  const largePolicy = { ...policy, capture: { ...policy.capture, maxTextCharacters: 200_000 } };
  const normalized = normalizeCapture({ ...capture(), text: 'L'.repeat(60_000), text_total_chars: 60_000, truncated: false }, largePolicy);
  assert.equal(normalized.text.length, 60_000);
  assert.equal(normalized.text_total_chars, 60_000);
  assert.equal(normalized.truncated, false);
});
const capture = () => ({ tabId: 42, title: 'Approved page', url: 'https://approved.example/private/path?secret=nope', text: 'Visible work text', elementSummary: [{ tag: 'button', text: 'Save' }, { tag: 'input', text: '' }], userInitiated: true, capturedAt: new Date().toISOString(), cookies: 'must-not-store', storage: { x: 'must-not-store' }, formValues: { password: 'must-not-store' } });

async function request(base, path, body, token) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function getRequest(base, path, token) {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function start(server, t) {
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EPERM') { t.skip('The sandbox does not permit loopback listeners.'); return null; } throw error; }
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('MCP initialize reports the package version', async (t) => {
  const base = await start(createServer({ policy, devToken: 'admin-token', env: { WORK_EDGE_MCP_TOKEN: 'admin-token' } }), t); if (!base) return;
  const initialized = await request(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }, 'admin-token');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'field-browser-bridge');
  assert.equal(initialized.body.result.serverInfo.version, packageJson.version);
});

test('screenshot capture requires granted reading, enforces sensitive-page policy, and sends no PNG through the command result', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const local = { hermesControlEnabled: true, sensitiveReadRestricted: true, approvedSensitiveReadOrigins: [], brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token' };
  const tab = { id: 42, windowId: 7, url: 'https://login.microsoftonline.com/signin' };
  let permissionGranted = false;
  let dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const requests = [];
  globalThis.chrome = {
    storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } } },
    permissions: { async contains() { return permissionGranted; } },
    tabs: { async query() { return [tab]; }, async captureVisibleTab() { return dataUrl; } },
  };
  globalThis.fetch = async (url, options) => { requests.push({ url: String(url), body: JSON.parse(options.body) }); return { ok: true }; };
  try {
    const command = { id: 'a'.repeat(16), type: 'screenshot' };
    assert.match((await screenshotActiveTab(tab, command)).error, /enable reading normal tabs/i);
    permissionGranted = true;
    assert.match((await screenshotActiveTab(tab, command)).error, /explicit read approval/i);
    local.sensitiveReadRestricted = false;
    const captured = await screenshotActiveTab(tab, command);
    assert.equal(captured.ok, true);
    assert.equal(captured.result.screenshotDelivered, true);
    assert.equal('screenshot' in captured.result, false, 'the PNG must use dedicated ingest, not the command result channel');
    assert.equal(requests[0].url, 'http://127.0.0.1:8765/work-edge/ingest-screenshot');
    assert.equal(requests[0].body.commandId, command.id);
    assert.equal(requests[0].body.dataUrl, dataUrl);
    dataUrl = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(5 * 1024 * 1024)}`;
    assert.match((await screenshotActiveTab(tab, command)).error, /5 MB limit/i);
    globalThis.fetch = async () => ({ ok: false });
    dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    assert.match((await screenshotActiveTab(tab, command)).error, /broker did not accept/i);
  } finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
});

test('policy rejects denied captures and whitelists persisted fields', () => {
  assert.throws(() => normalizeCapture({ ...capture(), url: 'https://approved.example/login' }, policy), /denied/);
  const normalized = normalizeCapture(capture(), policy);
  assert.equal('cookies' in normalized, false);
  assert.equal('storage' in normalized, false);
  assert.equal('formValues' in normalized, false);
  assert.equal(normalized.sensitiveReadRestricted, false);
  assert.equal(displayUrl(capture().url, policy), 'https://approved.example');
});

test('capture keeps safe field metadata and drops submitted values', () => {
  const normalized = normalizeCapture({ ...capture(), elementSummary: [{ ref: 'work-edge-search-1', tag: 'input', type: 'SEARCH', role: 'SEARCHBOX', name: 'Search jobs', hasValue: true, value: 'secret' }] }, policy);
  assert.deepEqual(normalized.elementSummary, [{ tag: 'input', text: 'Search jobs', role: 'searchbox', type: 'search', hasValue: true, ref: 'work-edge-search-1' }]);
  assert.equal('value' in normalized.elementSummary[0], false);
});

test('capture keeps only bounded mail row refs, text, and unread flags', () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ ref: `work-edge-row-${index}`, text: `Email ${index} ${'x'.repeat(350)}`, unread: index < 3, privateValue: 'secret' }));
  rows[0].ref = 'invalid ref';
  const normalized = normalizeCapture({ ...capture(), rows }, policy);
  assert.equal(normalized.rows.length, 39);
  assert.equal(normalized.rows[0].text.length, 300);
  assert.deepEqual(normalized.rows.slice(0, 2).map((row) => row.unread), [true, true]);
  assert.equal('privateValue' in normalized.rows[0], false);
});

test('read monitoring defaults to normal web tabs and never captures browser-internal tabs', () => {
  assert.deepEqual(autoCaptureEligibility({ id: 7, url: 'https://approved.example/inbox' }), { allowed: true, origin: 'https://approved.example' });
  assert.deepEqual(autoCaptureEligibility({ id: 7, url: 'https://unapproved.example/inbox' }), { allowed: true, origin: 'https://unapproved.example' });
  assert.deepEqual(autoCaptureEligibility({ id: 7, url: 'edge://settings/' }), { allowed: false, reason: 'not_capturable' });
  assert.doesNotThrow(() => normalizeCapture({ ...capture(), userInitiated: false, readOnlyWatch: true }, policy));
  assert.throws(() => normalizeCapture({ ...capture(), userInitiated: false }, policy), /explicitly user initiated or approved read-only watch/i);
  assert.throws(() => normalizeCapture({ ...capture(), userInitiated: false, readOnlyWatch: true, url: 'https://approved.example/login' }, policy), /denied/);
});

test('Outlook app origins share narrowly scoped sensitive-read trust', () => {
  const outlookOffice = 'https://outlook.office.com';
  const outlookCloud = 'https://outlook.cloud.microsoft';
  assert.deepEqual(autoCaptureEligibility({ id: 7, url: `${outlookCloud}/mail` }), { allowed: true, origin: outlookCloud });
  assert.equal(isApprovedOrigin(outlookCloud, [outlookOffice]), true, 'sensitive-read checks may use the same Outlook app group');
  assert.equal(isApprovedOrigin('https://account.microsoft.com', [outlookOffice]), false);
  assert.equal(isApprovedOrigin('https://login.microsoftonline.com', [outlookOffice]), false);
  assert.equal(isApprovedOrigin('https://www.office.com', [outlookOffice]), false);
});

test('control heartbeat reflects an already-open WebSocket and never leaves disable as starting', () => {
  assert.equal(controlHeartbeatState(true, true), 'websocket');
  assert.equal(controlHeartbeatState(true, false), 'starting');
  assert.equal(controlHeartbeatState(false, true), 'off');
  assert.equal(controlHeartbeatState(false, false), 'off');
});

test('runner diagnostics use only bounded transport lifecycle labels', () => {
  assert.equal(runnerDiagnostic(true, false, false, null), 'offscreen_absent');
  assert.equal(runnerDiagnostic(true, true, false, null), 'runner_configured_unacknowledged');
  assert.equal(runnerDiagnostic(true, true, true, 'websocket'), 'websocket_active');
  assert.equal(runnerDiagnostic(true, true, true, 'active'), 'polling_recovery_active');
  assert.equal(runnerDiagnostic(true, true, true, 'failed'), 'no_viable_command_transport');
  assert.equal(runnerDiagnostic(false, false, false, null), 'control_disabled');
});

test('durable runner renews its WSS lease and recovers the next command through polling after WSS loss', async () => {
  const originalSelf = globalThis.self;
  const originalPostMessage = globalThis.postMessage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const sent = [];
  const executed = [];
  let socket;
  let pollCount = 0;
  let runner;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      socket = this;
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }
    send(value) { sent.push(JSON.parse(value)); }
    close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  }
  globalThis.self = {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.postMessage = (message) => {
    if (message.type !== 'execute-command') return;
    executed.push(message.command.id);
    queueMicrotask(() => runner.onmessage({ data: { type: 'command-result', deliveryId: message.deliveryId, outcome: { ok: true, result: { waitedMs: message.command.ms } } } }));
  };
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/poll')) {
      pollCount += 1;
      if (pollCount === 1) return { ok: true, async json() { return { command: { id: 'recovered-wait', type: 'wait', ms: 1 } }; } };
      return new Promise(() => {});
    }
    assert.match(url, /\/result$/);
    assert.equal(JSON.parse(options.body).id, 'recovered-wait');
    return { ok: true, async json() { return {}; } };
  };
  try {
    await import(`../extension/command-runner-worker.js?lease-recovery=${Date.now()}`);
    runner = globalThis.self;
    runner.onmessage({ data: { type: 'configure', settings: { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', controlEnabled: true, extensionVersion: '1.0.0' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onmessage({ data: JSON.stringify({ type: 'command', seq: 1, command: { id: 'first-wait', type: 'wait', ms: 1 } }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(executed, ['first-wait']);
    assert.ok(sent.some((message) => message.type === 'result' && message.id === 'first-wait'));

    // The runner must keep the broker lease alive while its WSS remains open;
    // otherwise a healthy-looking socket becomes ineligible before command two.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(sent.some((message) => message.type === 'keepalive'), 'the durable runner must renew its WSS command lease after a successful command');

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(executed, ['first-wait', 'recovered-wait'], 'the next command must execute through the authenticated polling recovery path');
  } finally {
    runner?.onmessage({ data: { type: 'stop' } });
    globalThis.self = originalSelf;
    globalThis.postMessage = originalPostMessage;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test('stale command-runner callbacks cannot revive a replaced transport or deliver commands', async () => {
  const originalSelf = globalThis.self;
  const originalPostMessage = globalThis.postMessage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const sockets = [];
  const published = [];
  const sent = [];
  const scheduled = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; sockets.push(this); }
    send(value) { sent.push({ socket: this, message: JSON.parse(value) }); }
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }
  globalThis.self = {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.postMessage = (message) => published.push(message);
  globalThis.fetch = async () => { throw new Error('stale callback must not begin polling'); };
  globalThis.setTimeout = (callback) => { scheduled.push(callback); return 1; };
  try {
    await import(`../extension/command-runner-worker.js?generation-fence=${Date.now()}`);
    const runner = globalThis.self;
    const settings = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', controlEnabled: true, extensionVersion: '1.0.0' };
    runner.onmessage({ data: { type: 'configure', settings } });
    const stale = sockets[0];
    runner.onmessage({ data: { type: 'configure', settings: { ...settings, extensionVersion: '1.0.1' } } });
    const active = sockets[1];
    const transportStatesBeforeStaleCallbacks = published.filter((message) => message.type === 'transport-state').length;

    stale.readyState = FakeWebSocket.OPEN;
    stale.onopen();
    stale.onmessage({ data: JSON.stringify({ type: 'hello', ok: true }) });
    stale.onmessage({ data: JSON.stringify({ type: 'command', seq: 1, command: { id: 'stale-command', type: 'wait', ms: 1 } }) });
    stale.onclose();
    for (const callback of scheduled) callback();

    assert.equal(sent.filter((entry) => entry.socket === stale).length, 0, 'stale onopen cannot authenticate or acknowledge a command');
    assert.equal(published.filter((message) => message.type === 'execute-command').length, 0, 'stale onmessage cannot deliver a command');
    assert.equal(published.filter((message) => message.type === 'transport-state').length, transportStatesBeforeStaleCallbacks, 'stale callbacks cannot publish transport state');
    assert.equal(sockets.length, 2, 'stale onclose cannot start a reconnect');
    assert.equal(active.readyState, FakeWebSocket.CONNECTING);
  } finally {
    globalThis.self = originalSelf;
    globalThis.postMessage = originalPostMessage;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('control-on ensures the offscreen durable runner without a popup port', async () => {
  const originalChrome = globalThis.chrome;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: true };
  const created = [];
  const configured = [];
  globalThis.chrome = {
    runtime: {
      id: 'durable-runner-test',
      getURL(path) { return `chrome-extension://durable-runner-test/${path}`; },
      async getContexts() { return []; },
      async sendMessage(message) { configured.push(message); return { ok: true, ready: true }; },
      onMessage: { addListener() {} }, onConnect: { addListener() {} }
    },
    offscreen: { async createDocument(options) { created.push(options); } },
    storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); } }, session: { async get() { return {}; }, async set() {} } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  try {
    assert.equal(await ensureDurableCommandRunner(), true);
    assert.deepEqual(created, [{ url: 'offscreen.html', reasons: ['WORKERS', 'AUDIO_PLAYBACK'], justification: 'Keep the Field Browser Bridge command transport worker awake while control is enabled.' }]);
    assert.deepEqual(configured, [{ type: 'durable-runner-configure', brokerUrl: local.brokerUrl, brokerToken: local.brokerToken, controlEnabled: true, extensionVersion: null, swap: { active: false, rules: false } }]);
  } finally { globalThis.chrome = originalChrome; }
});

test('concurrent wake paths recreate one lost offscreen runner and configure it once', async () => {
  const originalChrome = globalThis.chrome;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: true };
  let exists = false;
  let created = 0;
  const configured = [];
  globalThis.chrome = {
    runtime: {
      id: 'offscreen-recreate-test', getURL(path) { return `chrome-extension://offscreen-recreate-test/${path}`; },
      async getContexts() { return exists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
      async sendMessage(message) { configured.push(message); return { ok: true, ready: true }; },
      onMessage: { addListener() {} }, onConnect: { addListener() {} }, getManifest() { return { version: '1.0.0' }; }
    },
    offscreen: { async createDocument() { created += 1; exists = true; } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); } },
      session: { async get() { return {}; }, async set() {} }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  try {
    assert.deepEqual(await Promise.all([ensureDurableCommandRunner(), ensureDurableCommandRunner(), ensureDurableCommandRunner()]), [true, true, true]);
    assert.equal(created, 1, 'context loss is recreated once');
    assert.equal(configured.length, 1, 'parallel wakes cannot restart the singleton runner repeatedly');
  } finally { globalThis.chrome = originalChrome; }
});

test('a stale offscreen heartbeat closes and recreates the document', async () => {
  const originalChrome = globalThis.chrome;
  let exists = true;
  let closed = 0;
  let created = 0;
  const session = { commandPollHeartbeat: { state: 'websocket', at: Date.now() - 31_000 } };
  globalThis.chrome = {
    runtime: {
      getURL(path) { return `chrome-extension://stale-runner-test/${path}`; },
      async getContexts() { return exists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
      async sendMessage() { return { ok: true, ready: true }; }
    },
    offscreen: {
      async closeDocument() { closed += 1; exists = false; },
      async createDocument() { created += 1; exists = true; }
    },
    storage: {
      local: { async get() { return { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: true }; } },
      session: { async get() { return session; }, async set(values) { Object.assign(session, values); } }
    }
  };
  try {
    assert.equal(await ensureDurableCommandRunner(), true);
    assert.equal(closed, 1);
    assert.equal(created, 1);
  } finally { globalThis.chrome = originalChrome; }
});

test('control-off closes the offscreen runner before it can retain command transport credentials', async () => {
  const originalChrome = globalThis.chrome;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: false };
  let closed = 0;
  globalThis.chrome = {
    runtime: { id: 'durable-runner-stop-test', getURL(path) { return `chrome-extension://durable-runner-stop-test/${path}`; }, async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; }, onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    offscreen: { async closeDocument() { closed += 1; } },
    storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); } }, session: { async get() { return {}; }, async set() {} } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  try {
    assert.equal(await ensureDurableCommandRunner(), false);
    assert.equal(closed, 1);
  } finally { globalThis.chrome = originalChrome; }
});

test('offscreen runner is reconfigured on a capture wake and is not treated as healthy until it confirms transport', async () => {
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: true };
  const session = { commandPollHeartbeat: { state: 'websocket', diagnostic: 'websocket_active', at: Date.now() } };
  const configured = [];
  globalThis.WebSocket = undefined;
  globalThis.chrome = {
    runtime: {
      id: 'durable-runner-wake-test', getURL(path) { return `chrome-extension://durable-runner-wake-test/${path}`; },
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
      async sendMessage(message) { configured.push(message); return { ok: false, ready: false }; },
      onMessage: { addListener() {} }, onConnect: { addListener() {} }, getManifest() { return { version: '1.0.0' }; }
    },
    offscreen: { async createDocument() { throw new Error('existing runner must not be recreated'); } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove() {} }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 },
    scripting: { async executeScript() { return [{ result: { title: 'Approved page', url: 'https://approved.example/path', text: 'safe visible text', elementSummary: [] } }]; } }
  };
  try {
    const worker = await import(`../extension/service-worker.js?offscreen-wake=${Date.now()}`);
    const configurationsBeforeCapture = configured.length;
    await worker.captureTabForDelivery({ id: 42, url: 'https://approved.example/path' }, false, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(configured.length, configurationsBeforeCapture, 'a fresh offscreen heartbeat keeps the existing runner');
    assert.deepEqual(session.commandPollHeartbeat, { state: 'failed', diagnostic: 'no_viable_command_transport', at: session.commandPollHeartbeat.at });
    assert.equal(controlHeartbeatState(true, false), 'starting', 'unconfirmed runner transport must not be reported healthy');
  } finally { globalThis.chrome = originalChrome; globalThis.WebSocket = originalWebSocket; }
});

test('command transport falls back to authenticated polling when WSS closes while control is enabled', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: true };
  const session = {};
  let polls = 0;
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); },
        async set(values) { Object.assign(local, values); }
      },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove() {} }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  globalThis.fetch = async () => {
    polls += 1;
    local.hermesControlEnabled = false;
    return { ok: true, json: async () => ({ ok: true, command: null }) };
  };
  try {
    const worker = await import(`../extension/service-worker.js?wss-fallback=${Date.now()}`);
    await worker.recoverCommandTransport();
    assert.equal(polls, 1, 'an enabled control session must begin recovery polling after WSS closes');
    assert.equal(session.commandPollHeartbeat.state, 'active');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test('a cold MV3 worker never starts a competing service-worker command transport', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-worker-wake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'worker-wake-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, tokenStore, commandQueue: queue }), t); if (!base) return;
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const local = { brokerUrl: `${base}/ingest`, brokerToken: token, hermesControlEnabled: true };
  const session = {};
  globalThis.WebSocket = class UnavailableWebSocket {
    static OPEN = 1;
    constructor() { throw new Error('WebSocket is unavailable during cold-worker recovery'); }
  };
  globalThis.chrome = {
    runtime: { id: 'cold-worker', onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); },
        async set(values) { Object.assign(local, values); }
      },
      session: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); },
        async set(values) { Object.assign(session, values); },
        async remove() {}
      }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} }, async query() { return [{ id: 1, url: 'https://approved.example/inbox', title: 'Inbox' }]; } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 },
    scripting: { async executeScript({ func, args }) { const result = await func(...args); local.hermesControlEnabled = false; return [{ result }]; } }
  };
  try {
    await import(`../extension/service-worker.js?cold-worker-poll=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const browserDigest = createHash('sha256').update(token).digest('hex');
    assert.equal(queue.hasOnlineBrowser(browserDigest), false, 'only the offscreen runner may establish a command lease');
    assert.equal(queue.hasActivePollingWaiter(browserDigest), false, 'a cold service worker must not create a second polling consumer');
  } finally {
    local.hermesControlEnabled = false;
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('extension registers a durable command-transport wakeup for MV3 worker recovery', async () => {
  const originalChrome = globalThis.chrome;
  const alarms = [];
  let alarmListener;
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    alarms: { create: (...args) => alarms.push(args), onAlarm: { addListener(listener) { alarmListener = listener; } } },
    storage: { local: { async get() { return {}; } }, session: { async get() { return {}; } } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  try {
    await import(`../extension/service-worker.js?command-transport-alarm=${Date.now()}`);
    assert.deepEqual(alarms, [['work-edge-command-transport', { periodInMinutes: 0.5 }]]);
    assert.equal(typeof alarmListener, 'function');
  } finally { globalThis.chrome = originalChrome; }
});

test("wildcard allowOrigins releases normal origins without weakening existing deny prefixes", () => {
  const releasedPolicy = { ...policy, allowOrigins: ['*'] };
  assert.doesNotThrow(() => normalizeCapture({ ...capture(), url: 'https://www.walmart.com/department/toys?campaign=private' }, releasedPolicy));
  assert.throws(() => normalizeCapture({ ...capture(), url: 'https://approved.example/login' }, releasedPolicy), /denied/);
  assert.equal(displayUrl('https://www.walmart.com/department/toys?campaign=private', releasedPolicy), 'https://www.walmart.com');
  assert.equal(allowedUrl('https://www.walmart.com/', { ...policy, allowOrigins: [] }), false);
  assert.throws(() => validatePolicy({ ...policy, allowOrigins: ['https://approved.example/path'] }), /allowOrigins/);
});

test('example policy releases allowlist without adding deny URL prefixes', () => {
  const example = JSON.parse(readFileSync(new URL('../config/policy.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.allowOrigins, ['*']);
  assert.deepEqual(example.denyUrlPrefixes, ['edge://', 'chrome://', 'file://', 'about:', 'https://login.microsoftonline.com/', 'https://account.microsoft.com/']);
});

test('policy validates listen configuration and runtime uses its host', () => {
  assert.throws(() => validatePolicy({ ...policy, listen: { host: '', port: 8765 } }), /listen.host/);
  assert.doesNotThrow(() => validatePolicy({ ...policy, listen: { host: '127.0.0.1', port: 0 } }));
  const calls = [];
  const fakeServer = { listen: (...args) => { calls.push(args); return fakeServer; } };
  const onListening = () => {};
  assert.equal(listenServer(fakeServer, { ...policy, listen: { host: '127.0.0.2', port: 8765 } }, onListening), fakeServer);
  assert.deepEqual(calls, [[8765, '127.0.0.2', onListening]]);
});

test('broker URL validation permits HTTPS servers and explicit-port loopback HTTP', () => {
  assert.equal(validateBrokerUrl('http://127.0.0.1:8765/ingest'), true);
  assert.equal(validateBrokerUrl('http://127.0.0.1:80/ingest'), true);
  assert.equal(validateBrokerUrl('http://127.0.0.1:9000/work-edge/ingest'), true);
  assert.equal(validateBrokerUrl('http://127.0.0.1:8765/'), true);
  assert.equal(validateBrokerUrl('http://127.0.0.1:80/'), true);
  assert.equal(validateBrokerUrl('http://localhost:8765/ingest'), true);
  assert.equal(validateBrokerUrl(HOSTED_INGEST_URL), false);
  assert.equal(validateBrokerUrl('https://example.com/work-edge/ingest'), true);
  assert.equal(normalizeBrokerUrl('https://bridge.example.com'), 'https://bridge.example.com');
  assert.equal(normalizeBrokerUrl('https://bridge.example.com/'), 'https://bridge.example.com/');
  assert.equal(validateBrokerUrl('https://bridge.example.com'), true);
  assert.equal(validateBrokerUrl('https://bridge.example.com/'), true);
  const denied = ['http://127.0.0.1/ingest', 'http://127.0.0.1/', 'http://127.0.0.1:/ingest', 'http://127.0.0.1:0/ingest', 'http://127.0.0.1:65536/ingest', 'http://127.0.0.1:8765/in gest', 'http://127.0.0.1:8765/ingest?x=1', 'http://127.0.0.1:8765/ingest#f', 'http://127.0.0.1:8765/?x=1', 'http://127.0.0.1:8765/#f', 'http://localhost/ingest', 'http://127.0.0.2:8765/ingest', 'http://user:pass@127.0.0.1:8765/ingest', 'http://example.com:8765/ingest', ' http://127.0.0.1:8765/ingest', 'https://bridge.example.com/work-edge/ingest?x=1', 'https://bridge.example.com/work-edge/ingest#f', 'https://user@bridge.example.com/work-edge/ingest', '', null];
  for (const url of denied) assert.equal(validateBrokerUrl(url), false, String(url));
});

test('durable command records sequence, replay, and idempotent results', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-command-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'command-state.json');
  let now = 1000;
  const first = new BrowserCommandQueue({ stateFile, now: () => now });
  first.markOnline('browser-a');
  const command = buildCommand('edge_click', { selector: '#safe' }).command;
  first.enqueue('browser-a', command);
  const delivered = first.nextForBrowser('browser-a', 0, 0);
  assert.equal(delivered.seq, 1);
  assert.equal(delivered.command.id, command.id);
  assert.equal(first.record(command.id).state, 'delivered');

  const restarted = new BrowserCommandQueue({ stateFile, now: () => now });
  assert.equal(restarted.nextForBrowser('browser-a', 0, 0).seq, 1, 'uncompleted command is replayed after restart');
  assert.equal(restarted.submitResult('browser-a', command.id, { ok: true, result: { clicked: true } }), true);
  assert.equal(restarted.submitResult('browser-a', command.id, { ok: true, result: { clicked: false } }), true, 'duplicate result is accepted idempotently');
  assert.deepEqual(restarted.record(command.id).result, { ok: true, result: { clicked: true } });
  const afterCompletion = new BrowserCommandQueue({ stateFile, now: () => now });
  assert.equal(afterCompletion.nextForBrowser('browser-a', 0, 0), null);
});

test('broker marks final actions for the approval path and ignores agent-approved flags', () => {
  for (const args of [
    { targetText: 'Remove connection', approved: true },
    { targetText: 'Send message', approved: true },
    { url: 'https://approved.example/upload', approved: true }
  ]) {
    const tool = 'url' in args ? 'edge_navigate' : 'edge_click';
    assert.equal(buildCommand(tool, args).command.finalAction, true);
    assert.equal(buildCommand(tool, args).command.approved, false);
  }
});

test('targetText opens a Gmail-style message row when the subject is not itself a link or button', () => {
  const originalDocument = globalThis.document;
  let clicks = 0;
  const row = {
    innerText: 'The Los Angeles Film School Your September 25 Virtual Graduation Details',
    textContent: 'The Los Angeles Film School Your September 25 Virtual Graduation Details',
    getAttribute() { return null; },
    matches() { return false; },
    click() { clicks += 1; }
  };
  globalThis.document = {
    querySelector() { return null; },
    querySelectorAll(selector) { return selector.includes('[role="row"]') ? [row] : []; }
  };
  try {
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { targetText: 'Your September 25 Virtual Graduation Details' } }), { ok: true, result: { clicked: true } });
    assert.equal(clicks, 1);
  } finally { globalThis.document = originalDocument; }
});

test('live mailbox discovery returns bounded safe Outlook rows with click refs while pane extraction stays scoped', () => {
  const originalDocument = globalThis.document;
  let clicked = 0;
  const graduationRow = {
    tagName: 'DIV', innerText: 'The Los Angeles Film School — Your September 25 Virtual Graduation Details', textContent: 'The Los Angeles Film School — Your September 25 Virtual Graduation Details',
    getAttribute(name) { return name === 'role' ? 'row' : null; }, setAttribute() {},
    matches(selector) { return selector === 'input,textarea,select,option,[contenteditable="true"]' ? false : selector.includes('[role="button"]') ? false : false; },
    closest() { return null; }, focus() {}, dispatchEvent() { clicked += 1; return true; }
  };
  const hiddenRow = { tagName: 'DIV', innerText: 'Hidden graduation draft', textContent: 'Hidden graduation draft', hidden: true, getAttribute(name) { return name === 'role' ? 'row' : null; }, matches() { return false; } };
  const send = { tagName: 'BUTTON', innerText: 'Send', textContent: 'Send', getAttribute() { return null; }, matches(selector) { return selector.includes('button'); }, closest() { return null; } };
  const refs = new Map();
  globalThis.document = {
    querySelector(selector) { const match = selector.match(/^\[data-work-edge-ref="(.+)"\]$/); return match ? refs.get(match[1]) || null : null; },
    querySelectorAll(selector) { return selector === '[role=row]' ? [graduationRow, hiddenRow] : selector === 'button' ? [send] : []; }
  };
  const originalStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => ({ display: element.hidden ? 'none' : 'block', visibility: element.hidden ? 'hidden' : 'visible' });
  graduationRow.setAttribute = (name, value) => { if (name === 'data-work-edge-ref') refs.set(value, graduationRow); };
  try {
    const found = executeBrowserCommand({ type: 'find', selector: '[role=row]' });
    assert.equal(found.ok, true);
    assert.equal(found.result.matches.length, 1);
    assert.match(found.result.matches[0].text, /Graduation Details/);
    assert.ok(found.result.matches[0].ref);
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { ref: found.result.matches[0].ref } }), { ok: true, result: { clicked: true } });
    assert.equal(clicked, 5);
    const unsafe = executeBrowserCommand({ type: 'find', selector: 'button' });
    assert.equal(unsafe.result.matches.length, 1);
    assert.equal(unsafe.result.matches[0].unsafe, true);
    assert.equal(typeof unsafe.result.matches[0].ref, 'string');
    assert.equal(buildCommand('edge_find_elements', { selector: '[aria-label*=Graduation]', scope: 'live' }).command.type, 'find');
    assert.match(executeBrowserCommand({ type: 'find', selector: '[role=row] > *' }).error, /simple selector/i);
  } finally { globalThis.document = originalDocument; globalThis.getComputedStyle = originalStyle; }
});

test('live element discovery is a read-only scoped tool with bounded simple selectors', () => {
  const tool = READ_ONLY_TOOLS.find((entry) => entry.name === 'edge_find_elements');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.scope.enum, ['capture', 'live']);
  assert.equal(buildCommand('edge_find_elements', { selector: '[role=row]', scope: 'live' }).command.type, 'find');
});

test('click dispatches a coordinate-bearing SPA pointer and mouse activation sequence to a React-like listener', () => {
  const originalDocument = globalThis.document;
  const originalPointerEvent = globalThis.PointerEvent;
  const originalMouseEvent = globalThis.MouseEvent;
  const events = [];
  const eventDetails = [];
  class BrowserEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const row = {
    innerText: 'Outlook subject: Budget review', textContent: 'Outlook subject: Budget review',
    getAttribute() { return null; }, matches(selector) { return selector.includes('[role="row"]'); },
    focus() { events.push('focus'); },
    scrollIntoView(options) { events.push(`scroll:${options.block}:${options.inline}`); },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; },
    dispatchEvent(event) { events.push(event.type); eventDetails.push(event); return true; }
  };
  globalThis.PointerEvent = BrowserEvent;
  globalThis.MouseEvent = BrowserEvent;
  globalThis.document = { querySelector() { return null; }, querySelectorAll() { return [row]; } };
  try {
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { targetText: 'Budget review' } }), { ok: true, result: { clicked: true } });
    assert.deepEqual(events, ['scroll:center:center', 'focus', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    for (const event of eventDetails) {
      assert.equal(event.clientX, 60);
      assert.equal(event.clientY, 40);
      assert.equal(event.pageX, 60);
      assert.equal(event.pageY, 40);
      assert.equal(event.screenX, 60);
      assert.equal(event.screenY, 40);
    }
  } finally { globalThis.document = originalDocument; globalThis.PointerEvent = originalPointerEvent; globalThis.MouseEvent = originalMouseEvent; }
});

test('click activates a Fluent-like row only after pointerup at its center', () => {
  const originalDocument = globalThis.document;
  const originalPointerEvent = globalThis.PointerEvent;
  const originalMouseEvent = globalThis.MouseEvent;
  let selected = false;
  class BrowserEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const row = {
    innerText: 'Outlook subject: Graduation', textContent: 'Outlook subject: Graduation',
    getAttribute() { return null; }, matches(selector) { return selector.includes('[role="row"]'); },
    focus() {}, scrollIntoView() {}, getBoundingClientRect() { return { left: 50, top: 100, width: 200, height: 60 }; },
    dispatchEvent(event) {
      if (event.type === 'pointerup' && event.clientX === 150 && event.clientY === 130 && event.buttons === 0) selected = true;
      return true;
    }
  };
  globalThis.PointerEvent = BrowserEvent;
  globalThis.MouseEvent = BrowserEvent;
  globalThis.document = { querySelector() { return null; }, querySelectorAll() { return [row]; } };
  try {
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { targetText: 'Graduation' } }), { ok: true, result: { clicked: true } });
    assert.equal(selected, true);
  } finally { globalThis.document = originalDocument; globalThis.PointerEvent = originalPointerEvent; globalThis.MouseEvent = originalMouseEvent; }
});

test('edge_press uses a constrained key and sends key events to focused Outlook controls', () => {
  const originalDocument = globalThis.document;
  const originalKeyboardEvent = globalThis.KeyboardEvent;
  const events = [];
  class BrowserEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const searchbox = {
    innerText: '', textContent: '', getAttribute(name) { return name === 'aria-label' ? 'Search mail' : null; },
    matches() { return false; }, focus() { events.push('focus'); }, dispatchEvent(event) { events.push(`${event.type}:${event.key}`); return true; }
  };
  globalThis.KeyboardEvent = BrowserEvent;
  globalThis.document = { activeElement: searchbox, querySelector() { return null; }, querySelectorAll() { return []; } };
  try {
    assert.deepEqual(buildCommand('edge_press', { key: 'Enter' }).command.type, 'press');
    assert.deepEqual(executeBrowserCommand({ type: 'press', key: 'Enter' }), { ok: true, result: { pressed: 'Enter', submitted: 'none' } });
    assert.deepEqual(events, ['focus', 'keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
    assert.match(buildCommand('edge_press', { key: 'Ctrl+L' }).error, /must be one of/i);
  } finally { globalThis.document = originalDocument; globalThis.KeyboardEvent = originalKeyboardEvent; }
});

test('executor blocks final-action names and protected fields but permits non-final Outlook rows', () => {
  const originalDocument = globalThis.document;
  const makeElement = ({ text, matches, attributes = {}, parent = null }) => ({
    innerText: text, textContent: text, getAttribute(name) { return attributes[name] || null; }, matches, closest() { return parent; }, focus() {}, dispatchEvent() { throw new Error('must not activate'); }
  });
  const finalButton = makeElement({ text: 'Send message', matches(selector) { return selector.includes('button'); } });
  const password = makeElement({ text: '', attributes: { name: 'password' }, matches(selector) { return selector.includes('input[type="password"]'); } });
  const row = makeElement({ text: 'Delete Archive toolbar — Quarterly planning subject', matches(selector) { return selector.includes('[role="row"]'); } });
  const safeRow = makeElement({ text: 'Weekly planning subject', matches(selector) { return selector.includes('[role="row"]'); } });
  let dispatched = 0;
  row.dispatchEvent = () => { dispatched += 1; return true; };
  safeRow.dispatchEvent = () => { dispatched += 1; return true; };
  globalThis.document = { activeElement: finalButton, querySelector(selector) { return selector === '#send' ? finalButton : selector === '#password' ? password : null; }, querySelectorAll() { return [row, safeRow]; } };
  try {
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: '#send' } }).error, /final action/i);
    assert.match(executeBrowserCommand({ type: 'press', key: 'Enter' }).error, /final action/i);
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: '#password' } }).error, /password, hidden, MFA/i);
    assert.match(executeBrowserCommand({ type: 'click', target: { targetText: 'Quarterly planning subject' } }).error, /final action/i);
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { targetText: 'Weekly planning subject' } }), { ok: true, result: { clicked: true } });
    assert.equal(dispatched, 5);
  } finally { globalThis.document = originalDocument; }
});

test('click and Enter refuse Send, Delete, Archive, Submit, and MFA controls', () => {
  const originalDocument = globalThis.document;
  const controls = ['Send', 'Delete', 'Archive', 'Submit'].map((label) => ({
    innerText: label, textContent: label, getAttribute() { return null; }, matches(selector) { return selector.includes('button'); },
    focus() {}, dispatchEvent() { throw new Error('must not activate final action'); }
  }));
  const mfa = {
    innerText: '', textContent: '', getAttribute(name) { return name === 'aria-label' ? 'MFA verification code' : null; },
    matches() { return false; }, focus() {}, dispatchEvent() { throw new Error('must not activate protected field'); }
  };
  globalThis.document = { activeElement: null, querySelector(selector) { return selector === '#mfa' ? mfa : controls.find((control) => selector === `#${control.innerText.toLowerCase()}`) || null; }, querySelectorAll() { return []; } };
  try {
    for (const control of controls) {
      assert.match(executeBrowserCommand({ type: 'click', target: { selector: `#${control.innerText.toLowerCase()}` } }).error, /final action/i);
      globalThis.document.activeElement = control;
      assert.match(executeBrowserCommand({ type: 'press', key: 'Enter' }).error, /final action/i);
    }
    assert.match(executeBrowserCommand({ type: 'press', key: 'Enter', target: { selector: '#mfa' } }).error, /password, hidden, MFA/i);
  } finally { globalThis.document = originalDocument; }
});

test('scroll and wait remain toggle-gated control tools, not watch tools', () => {
  for (const name of ['edge_scroll', 'edge_wait']) {
    const tool = ACTION_TOOLS.find((entry) => entry.name === name);
    assert.match(tool.description, /control toggle/i);
    assert.doesNotMatch(tool.description, /five.minute|expires/i);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
});


test('approved origins allow redacted reads while browser-internal pages remain unreadable', () => {
  assert.equal(isCapturableUrl('https://login.example.test/sign-in'), true);
  assert.equal(isCapturableUrl('edge://settings'), false);
  assert.equal(isCapturableUrl('file:///work/private.txt'), false);
  assert.equal(isSensitivePage({ url: 'https://example.test/account', sensitiveSignals: [] }), true);
  assert.equal(isSensitivePage({ url: 'https://example.test/work', sensitiveSignals: ['mfa'] }), true);
  assert.deepEqual(normalizeApprovedOrigins(['https://example.test', 'https://example.test', 'edge://settings', 'bad']), ['https://example.test']);
  const captureScript = readFileSync(new URL('../extension/content/capture.js', import.meta.url), 'utf8');
  assert.match(captureScript, /input, textarea, select, option, script, style, noscript/);
  assert.match(captureScript, /input, textarea, select, option, \[contenteditable\]/);
  assert.match(captureScript, /Field names and occupancy are safe to expose/);
  assert.doesNotMatch(captureScript, /(?:value|defaultValue):\s*element\.(?:value|defaultValue)\b/);
  assert.doesNotMatch(captureScript, /document\.cookie|localStorage|sessionStorage|authorization/i);
  const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /Live discovery is limited to approved read origins/);
  assert.match(worker, /Live discovery on a sensitive page requires sensitive-read approval/);
});

test('sensitive-read restriction is opt-in, follows Outlook app redirects only, and never enables control', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', approvedReadOrigins: [] };
  const session = {};
  const tab = { id: 42, title: 'Inbox', url: 'https://outlook.office.com/mail/' };
  const delivered = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove() {} }
    },
    tabs: { async query() { return [tab]; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: { async executeScript() { return [{ result: { title: tab.title, url: tab.url, text: 'Sanitized inbox subject', elementSummary: [], sensitiveSignals: ['mail'] } }]; } }
  };
  globalThis.fetch = async (_url, options) => { delivered.push(JSON.parse(options.body)); return { ok: true }; };
  try {
    const worker = await import(`../extension/service-worker.js?sensitive-read=${Date.now()}`);
    const unrestricted = await worker.captureTabForDelivery(tab, true, false);
    assert.equal(unrestricted.sent, true);
    assert.equal(unrestricted.needsApproval, undefined);
    assert.equal(unrestricted.sensitiveReadRestricted, false);
    assert.equal(unrestricted.sensitiveReadPersistent, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, 'Sanitized inbox subject');

    local.sensitiveReadRestricted = true;
    const blocked = await worker.captureTabForDelivery(tab, true, false);
    assert.equal(blocked.sent, false);
    assert.equal(blocked.needsApproval, true);
    assert.equal(blocked.sensitiveReadRestricted, true);
    assert.equal(delivered.length, 1);

    await worker.approveSensitiveReadOrigin();
    const allowed = await worker.captureTabForDelivery(tab, true, false);
    assert.equal(allowed.sent, true);
    assert.equal(allowed.sensitiveReadPersistent, true);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].text, 'Sanitized inbox subject');
    assert.equal(local.hermesControlEnabled, undefined);
    assert.deepEqual(await worker.executeCommandInActiveTab({ type: 'scroll', direction: 'down' }), { ok: false, error: 'Control is not enabled.' });

    tab.url = 'https://outlook.cloud.microsoft/mail/';
    const redirectedOutlook = await worker.captureTabForDelivery(tab, true, false);
    assert.equal(redirectedOutlook.sent, true);
    assert.equal(redirectedOutlook.sensitiveReadPersistent, true);
    assert.equal(delivered.length, 3);

    tab.url = 'https://account.microsoft.com/account';
    const unrelated = await worker.captureTabForDelivery(tab, true, false);
    assert.equal(unrelated.sent, false);
    assert.equal(unrelated.needsApproval, true);
    assert.equal(delivered.length, 3);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});


test('capture freshness rejects a different active tab and exposes origin-only active metadata', () => {
  const capture = { tabId: 7, title: 'Old page', url: 'https://example.test/old?secret=1' };
  const active = { id: 8, title: 'New page', url: 'https://example.test/new?secret=2' };
  assert.equal(isFreshCaptureForTab(capture, active), false);
  assert.equal(isFreshCaptureForTab(capture, { id: 7, title: 'Old page', url: 'https://example.test/old?secret=1' }), true);
  assert.deepEqual(activeTabMetadata(active), { title: 'New page', url: 'https://example.test' });
});

test('control toggle gates commands without a clock and reset pairing clears it', async () => {
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const local = { brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', hermesControlEnabled: false, approvedSensitiveReadOrigins: ['https://approved.example'] };
  const listeners = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, onConnect: { addListener() {} } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); },
        async set(values) { Object.assign(local, values); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]; }
      },
      session: { async get() { return {}; }, async set() {}, async remove() {} }
    },
    tabs: { async query() { return [{ id: 42, url: 'https://approved.example/' }]; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: { async executeScript() { return [{ result: { ok: true, result: { scrolled: true } } }]; } }
  };
  globalThis.WebSocket = undefined;
  try {
    const worker = await import(`../extension/service-worker.js?control-toggle=${Date.now()}`);
    assert.deepEqual(await worker.executeCommandInActiveTab({ type: 'scroll', direction: 'down' }), { ok: false, error: 'Control is not enabled.' });
    local.hermesControlEnabled = true;
    const scrolled = await worker.executeCommandInActiveTab({ type: 'scroll', direction: 'down' });
    assert.equal(scrolled.ok, true);
    assert.equal(scrolled.result.scrolled, true);
    assert.equal(scrolled.result.captureDelivered, false);
    assert.match(scrolled.result.captureError, /cannot be read/i);
    assert.equal(listeners.length, 1, 'reset pairing listener must exist');
    const [resetListener] = listeners;
    await new Promise((resolve) => resetListener({ type: 'reset-pairing' }, null, resolve));
    assert.equal(local.hermesControlEnabled, undefined);
    assert.deepEqual(local.approvedSensitiveReadOrigins, ['https://approved.example'], 'reset pairing preserves explicit per-site sensitive-read trust');
  } finally { globalThis.chrome = originalChrome; globalThis.WebSocket = originalWebSocket; }
});

test('a control-enabled capture wake does not start a competing service-worker command recovery path', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const local = { hermesControlEnabled: true, brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token' };
  const session = {};
  const requests = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} }, getManifest() { return { version: '1.0.0' }; } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove(key) { delete session[key]; } }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: { async executeScript() { return [{ result: { title: 'Approved page', url: 'https://approved.example/path', text: 'safe visible text', elementSummary: [] } }]; } }
  };
  globalThis.WebSocket = undefined;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).includes('/commands/poll')) {
      local.hermesControlEnabled = false;
      return { ok: true, async json() { return {}; } };
    }
    return { ok: true, async json() { return {}; } };
  };
  try {
    const worker = await import(`../extension/service-worker.js?capture-command-recovery=${Date.now()}`);
    const captured = await worker.captureTabForDelivery({ id: 42, url: 'https://approved.example/path' }, true, false);
    assert.equal(captured.sent, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(requests.some((request) => request.url.includes('/ingest')));
    assert.equal(requests.some((request) => request.url.includes('/commands/poll')), false, 'only the offscreen runner may own command polling');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('remote navigation waits for its tab, delivers a fresh capture, and leaves the next command usable', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const local = { hermesControlEnabled: true, brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token' };
  const session = {};
  const updatedListeners = [];
  const tab = { id: 42, title: 'Old page', url: 'https://approved.example/old', active: true };
  const ingested = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove(key) { delete session[key]; } }
    },
    tabs: {
      async query() { return [tab]; },
      onActivated: { addListener() {} },
      onUpdated: { addListener(listener) { updatedListeners.push(listener); }, removeListener(listener) { updatedListeners.splice(updatedListeners.indexOf(listener), 1); } },
      update: async (tabId, values) => { assert.equal(tabId, 42); tab.url = values.url; tab.title = 'New page'; queueMicrotask(() => updatedListeners.forEach((listener) => listener(42, { status: 'complete' }, tab))); return tab; }
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: { async executeScript(options) { if (options.func?.name === 'capturePage') return [{ result: { title: tab.title, url: tab.url, text: 'Fresh page', elementSummary: [] } }]; return [{ result: { ok: true, result: { scrolled: true } } }]; } }
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/commands/poll')) return new Promise(() => {});
    ingested.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, async json() { return {}; } };
  };
  globalThis.WebSocket = undefined;
  try {
    const worker = await import(`../extension/service-worker.js?navigate-regression=${Date.now()}`);
    const navigate = await worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://approved.example/new' });
    assert.equal(navigate.ok, true);
    assert.equal(navigate.result.capture.url, 'https://approved.example');
    assert.equal(navigate.result.captureDelivered, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const captures = ingested.filter((request) => request.url.endsWith('/ingest'));
    assert.equal(captures.length, 2, 'navigation delivers the command capture and the default background monitoring refresh');
    assert.equal(captures[0].body.url, 'https://approved.example/new');
    const next = await worker.executeCommandInActiveTab({ type: 'scroll', direction: 'down' });
    assert.equal(next.ok, true);
    assert.equal(next.result.scrolled, true);
    assert.equal(next.result.captureDelivered, true);
    assert.equal(next.result.capture.url, 'https://approved.example');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('a successful Gmail row click settles and delivers a fresh approved capture', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const local = { hermesControlEnabled: true, brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', approvedSensitiveReadOrigins: ['https://mail.google.com'] };
  const session = {};
  const tab = { id: 42, title: 'Inbox - user.test - Gmail', url: 'https://mail.google.com/mail/u/0/#inbox', active: true };
  const ingested = [];
  let commandExecuted = false;
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove(key) { delete session[key]; } }
    },
    tabs: { async query() { return [tab]; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: {
      async executeScript(options) {
        if (options.func?.name !== 'capturePage') {
          commandExecuted = true;
          tab.title = 'Your September 25 Virtual Graduation Details - user.test - Gmail';
          tab.url = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQb';
          return [{ result: { ok: true, result: { clicked: true } } }];
        }
        assert.equal(commandExecuted, true, 'capture must follow the successful click');
        return [{ result: { title: tab.title, url: tab.url, text: 'Your September 25 Virtual Graduation Details\nFresh email body', elementSummary: [], sensitiveSignals: ['mail'] } }];
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/commands/poll')) return new Promise(() => {});
    ingested.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, async json() { return {}; } };
  };
  globalThis.WebSocket = undefined;
  try {
    const worker = await import(`../extension/service-worker.js?gmail-click-capture=${Date.now()}`);
    const outcome = await worker.executeCommandInActiveTab({ type: 'click', target: { targetText: 'Your September 25 Virtual Graduation Details' } });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.clicked, true);
    assert.equal(outcome.result.captureDelivered, true);
    assert.equal(outcome.result.capture.title, tab.title);
    assert.match(outcome.result.capture.text, /Fresh email body/);
    assert.equal(session.latestExplicitCapture.title, tab.title);
    const captures = ingested.filter((request) => request.url.endsWith('/ingest'));
    assert.equal(captures.length, 1);
    assert.match(captures[0].body.text, /Fresh email body/);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('a successful Outlook reading-pane press settles and delivers a fresh approved capture', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const local = { hermesControlEnabled: true, brokerUrl: 'http://127.0.0.1:8765/ingest', brokerToken: 'paired-token', approvedSensitiveReadOrigins: ['https://outlook.cloud.microsoft'] };
  const session = {};
  const tab = { id: 42, title: 'Inbox - Outlook', url: 'https://outlook.cloud.microsoft/mail/inbox', active: true };
  const ingested = [];
  let commandExecuted = false;
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(values) { Object.assign(local, values); } },
      session: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, session[key]])); }, async set(values) { Object.assign(session, values); }, async remove(key) { delete session[key]; } }
    },
    tabs: { async query() { return [tab]; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: {
      async executeScript(options) {
        if (options.func?.name !== 'capturePage') {
          commandExecuted = true;
          tab.title = 'Your September 25 Virtual Graduation Details - Outlook';
          return [{ result: { ok: true, result: { pressed: 'Enter' } } }];
        }
        assert.equal(commandExecuted, true, 'capture must follow the successful press');
        return [{ result: { title: tab.title, url: tab.url, text: 'Your September 25 Virtual Graduation Details\nYou are expected to graduate on Friday, September 25, 2026.', elementSummary: [], sensitiveSignals: [] } }];
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/commands/poll')) return new Promise(() => {});
    ingested.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, async json() { return {}; } };
  };
  globalThis.WebSocket = undefined;
  try {
    const worker = await import(`../extension/service-worker.js?outlook-press-capture=${Date.now()}`);
    const outcome = await worker.executeCommandInActiveTab({ type: 'press', key: 'Enter' });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.pressed, 'Enter');
    assert.equal(outcome.result.captureDelivered, true);
    assert.match(outcome.result.capture.text, /expected to graduate/);
    assert.match(session.latestExplicitCapture.text, /September 25, 2026/);
    assert.equal(ingested.filter((request) => request.url.endsWith('/ingest')).length, 1);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('released ingest feeds MCP readback without URL path leakage while public MCP stays unavailable', async (t) => {
  const releasedPolicy = { ...policy, allowOrigins: ['*'] };
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-released-ingest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserToken = 'released-browser-token';
  const browserDigest = createHash('sha256').update(browserToken).digest('hex');
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  browserRegistry.ensure(browserDigest);
  const commandQueue = new BrowserCommandQueue({ stateFile: '' });
  commandQueue.markOnline(browserDigest);
  const server = createServer({ policy: releasedPolicy, devToken: 'development-only-token', tokenStore, browserRegistry, commandQueue, env: { WORK_EDGE_MCP_TOKEN: 'development-only-token' } });
  const base = await start(server, t); if (!base) return;
  assert.equal((await request(base, '/ingest', capture())).status, 401);
  assert.equal((await request(base, '/ingest', capture(), 'development-only-token')).status, 401, 'the owner token is not a browser identity');
  assert.equal((await request(base, '/ingest', { ...capture(), url: 'https://approved.example/login' }, browserToken)).status, 400);
  const walmartCapture = { ...capture(), url: 'https://www.walmart.com/department/toys?campaign=private', approvedSensitiveOriginCount: 1, sensitiveReadPersistent: true };
  const ingested = await request(base, '/ingest', walmartCapture, browserToken);
  assert.equal(ingested.status, 202);
  const proxied = await request(base, '/work-edge/ingest', walmartCapture, browserToken);
  assert.equal(proxied.status, 202);
  assert.equal((await request(base, '/work-edge/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/list' })).status, 401);
  assert.equal(JSON.stringify(ingested.body).includes('/private/path'), false);
  assert.equal(JSON.stringify(ingested.body).includes('/department/toys'), false);
  assert.equal(ingested.body.capture.url, 'https://www.walmart.com');
  const listed = await request(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'development-only-token');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'edge_active_tab'));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'edge_bridge_status'));
  const bridgeStatus = await request(base, '/mcp', { jsonrpc: '2.0', id: 'bridge-status', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } }, 'development-only-token');
  const bridge = JSON.parse(bridgeStatus.body.result.content[0].text);
  assert.equal(bridge.bridge, 'work_browser_bridge');
  assert.equal(bridge.transport, 'paired_browser_outbound_wss_primary_https_recovery');
  assert.equal(bridge.watch.readOnlyCaptureDoesNotRequireArm, true);
  assert.equal(bridge.watch.approvedOriginsOnly, true);
  assert.equal(bridge.watch.sensitiveReadPersistent, true);
  assert.equal(bridge.watch.approvedSensitiveOriginCount, 1);
  assert.equal(typeof bridge.websocketLiveOrRecent, 'boolean');
  assert.equal(bridge.control.browserControlIsToggle, true);
  assert.equal(typeof bridge.control.enabled, 'boolean');
  assert.equal(bridge.control.explicitApprovalRequiredForFinalActions, true);
  assert.equal(JSON.stringify(bridge).includes('/department/toys'), false);
  const snapshot = await request(base, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_snapshot', arguments: {} } }, 'development-only-token');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.result.content[0].text.includes('/private/path'), false);
  assert.equal(snapshot.body.result.content[0].text.includes('/department/toys'), false);
  assert.equal(snapshot.body.result.content[0].text.includes('Visible work text'), true);
  for (const name of ['edge_list_tabs', 'edge_active_tab', 'edge_extract_text']) {
    const called = await request(base, '/mcp', { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } }, 'development-only-token');
    assert.equal(called.body.result.isError, undefined);
    assert.equal(called.body.result.content[0].text.includes('/private/path'), false);
  }
  const found = await request(base, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edge_find_elements', arguments: { selector: 'button' } } }, 'development-only-token');
  assert.match(found.body.result.content[0].text, /Save/);
  const action = await request(base, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'edge_click', arguments: {} } }, 'development-only-token');
  assert.equal(action.body.result.isError, true);
  assert.equal(action.body.result._meta.approvalRequired, true);
});

test('paired command polling delivers action commands and accepts their results', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add('browser-token');
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  browserRegistry.setAskBeforeFinalActions(browserRegistry.ensure(createHash('sha256').update('browser-token').digest('hex')).id, false);
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue: queue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  assert.equal((await request(base, '/commands/poll', {}, 'wrong')).status, 401);
  const stalePoll = await request(base, '/work-edge/commands/poll', { extensionVersion: '0.1.5' }, 'browser-token');
  assert.equal(stalePoll.status, 426);
  assert.match(stalePoll.body.error, /0\.1\.5 is below the minimum supported version 1\.0\.0/);
  const poll = request(base, '/work-edge/commands/poll', { waitMs: 500, extensionVersion: '1.0.0' }, 'browser-token');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const action = request(base, '/mcp', { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'edge_click', arguments: { selector: '#safe' } } }, 'agent-token');
  const delivered = await poll;
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.command.type, 'click');
  assert.equal(delivered.body.command.target.selector, '#safe');
  assert.equal((await request(base, '/commands/result', { id: delivered.body.command.id, ok: true, result: { clicked: true } }, 'browser-token')).status, 202);
  const completed = await action;
  assert.deepEqual(JSON.parse(completed.body.result.content[0].text), { ok: true, result: { clicked: true } });
  assert.equal((await request(base, '/commands/result', { id: 'expired', ok: true }, 'browser-token')).status, 404);
});

test('edge_screenshot returns only the fresh PNG bound to its browser and command', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-screenshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const screenshotPolicy = { ...policy, capture: { ...policy.capture, screenshotEnabled: true } };
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  const browserToken = 'browser-token';
  const peerBrowserToken = 'peer-browser-token';
  tokenStore.add(browserToken);
  tokenStore.add(peerBrowserToken);
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const store = new CaptureStore();
  const base = await start(createServer({ policy: screenshotPolicy, devToken: 'admin-token', tokenStore, commandQueue: queue, store, screenshotIngestWaitMs: 150, env: { WORK_EDGE_MCP_TOKEN: 'admin-token' } }), t); if (!base) return;
  const call = (id) => request(base, '/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'edge_screenshot', arguments: { timeoutMs: 500 } } }, 'admin-token');
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  const poll = request(base, '/work-edge/commands/poll', { waitMs: 500, controlEnabled: true, extensionVersion: '1.0.0' }, browserToken);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const screenshotCall = call(90);
  const delivered = await poll;
  assert.equal(delivered.body.command.type, 'screenshot');
  const capturedAt = new Date().toISOString();
  const payload = { commandId: delivered.body.command.id, tabId: 42, url: 'https://approved.example/private/path', capturedAt, dataUrl: png, mimeType: 'image/png' };
  assert.equal((await request(base, '/work-edge/ingest-screenshot', payload, 'admin-token')).status, 401, 'the MCP owner token cannot impersonate a paired browser');
  assert.equal((await request(base, '/work-edge/ingest-screenshot', payload, peerBrowserToken)).status, 409, 'a peer browser cannot satisfy another browser command');
  assert.equal((await request(base, '/work-edge/ingest-screenshot', { ...payload, dataUrl: 'data:image/png;base64,bm90LXBuZw==' }, browserToken)).status, 400, 'declared PNG data must have a PNG signature');
  assert.equal((await request(base, '/work-edge/ingest-screenshot', payload, browserToken)).status, 202);
  assert.equal(JSON.stringify(queue.record(delivered.body.command.id)).includes(png), false, 'PNG bytes must never enter the durable command record');
  assert.equal((await request(base, '/work-edge/commands/result', { id: delivered.body.command.id, ok: true, result: { tabId: 42, screenshotDelivered: true } }, browserToken)).status, 202);
  const screenshot = await screenshotCall;
  assert.deepEqual(screenshot.body.result.content, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
  assert.equal(screenshot.body.result._meta.rawScreen, true);
  assert.equal(screenshot.body.result._meta.capturedAt, capturedAt);
  assert.match(screenshot.body.result._meta.browserId, /^brw_[a-f0-9]{16}$/);

  const emptyPoll = request(base, '/work-edge/commands/poll', { waitMs: 500, controlEnabled: true, extensionVersion: '1.0.0' }, browserToken);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const emptyCall = call(91);
  const emptyCommand = await emptyPoll;
  assert.equal((await request(base, '/work-edge/commands/result', { id: emptyCommand.body.command.id, ok: true, result: { tabId: 42, screenshotDelivered: true } }, browserToken)).status, 202);
  const empty = await emptyCall;
  assert.equal(empty.body.result._meta.code, 'screenshot_not_stored');
});

test('stored screenshots are single-use and cannot cross command or browser boundaries', () => {
  const store = new CaptureStore();
  const screenshot = { commandId: '1111111111111111', tabId: 42, data: 'png' };
  store.putScreenshot('browser-a', screenshot);

  assert.equal(store.takeScreenshot('browser-a', '2222222222222222'), null);
  assert.equal(store.takeScreenshot('browser-b', '1111111111111111'), null);
  assert.equal(store.takeScreenshot('browser-a', '1111111111111111'), screenshot);
  assert.equal(store.takeScreenshot('browser-a', '1111111111111111'), null);
});

test('edge_screenshot fails closed when policy is disabled or the browser extension is too old', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-screenshot-gates-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add('browser-token');
  const disabledBase = await start(createServer({ policy, devToken: 'admin-token', tokenStore, commandQueue: new BrowserCommandQueue({ stateFile: '' }), env: { WORK_EDGE_MCP_TOKEN: 'admin-token' } }), t); if (!disabledBase) return;
  const mcp = { jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'edge_screenshot', arguments: {} } };
  const disabled = await request(disabledBase, '/mcp', mcp, 'admin-token');
  assert.equal(disabled.body.result._meta.code, 'screenshot_disabled');
  assert.equal((await request(disabledBase, '/work-edge/ingest-screenshot', {}, 'browser-token')).status, 403);

  const screenshotPolicy = { ...policy, capture: { ...policy.capture, screenshotEnabled: true } };
  const queue = new BrowserCommandQueue({ stateFile: '' });
  const enabledBase = await start(createServer({ policy: screenshotPolicy, devToken: 'admin-token', tokenStore, commandQueue: queue, env: { WORK_EDGE_MCP_TOKEN: 'admin-token' } }), t); if (!enabledBase) return;
  const stalePoll = request(enabledBase, '/work-edge/commands/poll', { waitMs: 100, controlEnabled: true, extensionVersion: '1.0.0' }, 'browser-token');
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.markOnline(createHash('sha256').update('browser-token').digest('hex'), true, '0.2.0');
  const stale = await request(enabledBase, '/mcp', mcp, 'admin-token');
  assert.equal(stale.body.result._meta.code, 'browser_upgrade_required');
  await stalePoll;
});

test('live element discovery uses the paired browser transport rather than the captured pane summary', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-live-find-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add('browser-token');
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, commandQueue: queue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  const poll = request(base, '/commands/poll', { waitMs: 500, controlEnabled: true, extensionVersion: '1.0.0' }, 'browser-token');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const find = request(base, '/mcp', { jsonrpc: '2.0', id: 88, method: 'tools/call', params: { name: 'edge_find_elements', arguments: { selector: '[role=row]', scope: 'live' } } }, 'agent-token');
  const delivered = await poll;
  assert.equal(delivered.body.command.type, 'find');
  assert.equal(delivered.body.command.selector, '[role=row]');
  assert.equal((await request(base, '/commands/result', { id: delivered.body.command.id, ok: true, result: { selector: '[role=row]', matches: [{ tag: 'div', text: 'Graduation details', ref: 'work-edge-test-row' }] } }, 'browser-token')).status, 202);
  const completed = await find;
  assert.deepEqual(JSON.parse(completed.body.result.content[0].text), { ok: true, result: { selector: '[role=row]', matches: [{ tag: 'div', text: 'Graduation details', ref: 'work-edge-test-row' }] } });
});

test('live discovery keeps sensitive URL safeguards only when sensitive reads are restricted', async () => {
  const originalChrome = globalThis.chrome;
  const local = { hermesControlEnabled: true, approvedSensitiveReadOrigins: [] };
  const tab = { id: 42, url: 'https://outlook.cloud.microsoft/mail/' };
  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); } } },
    tabs: { async query() { return [tab]; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    scripting: { async executeScript() { return [{ result: { ok: true, result: { matches: [] } } }]; } }
  };
  try {
    assert.deepEqual(await executeCommandInActiveTab({ type: 'find', selector: '[role=row]' }), { ok: true, result: { matches: [] } });
    tab.url = 'https://login.microsoftonline.com/';
    assert.deepEqual(await executeCommandInActiveTab({ type: 'find', selector: '[role=row]' }), { ok: true, result: { matches: [] } });
    local.sensitiveReadRestricted = true;
    assert.deepEqual(await executeCommandInActiveTab({ type: 'find', selector: '[role=row]' }), { ok: false, error: 'Live discovery on a sensitive page requires sensitive-read approval.' });
  } finally { globalThis.chrome = originalChrome; }
});

test('action tools report validation, no-browser, timeout, and browser-denial errors', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-command-errors-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add('browser-token');
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  const browserDigest = createHash('sha256').update('browser-token').digest('hex');
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue: queue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  const call = async (id, name, args) => request(base, '/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, 'agent-token');
  let response = await call(1, 'edge_click', {});
  assert.equal(response.body.result._meta.code, 'validation_failed');
  response = await call(2, 'edge_scroll', {});
  assert.equal(response.body.result._meta.code, 'no_default_browser');
  browserRegistry.ensure(browserDigest);
  browserRegistry.setAskBeforeFinalActions(browserRegistry.byDigest(browserDigest).id, false);
  queue.markOnline(browserDigest);
  response = await call(3, 'edge_wait', { ms: 1, timeoutMs: 10 });
  assert.equal(response.body.result._meta.code, 'no_online_browser', 'a heartbeat without WSS or an active poll is not command transport');
  const timeoutPoll = queue.poll(browserDigest, 100);
  response = await call(3, 'edge_wait', { ms: 1, timeoutMs: 10 });
  await timeoutPoll;
  assert.equal(response.body.result._meta.code, 'command_timeout');
  const denialPoll = queue.poll(browserDigest, 100);
  const deniedCall = call(4, 'edge_click', { selector: '#danger', timeoutMs: 500 });
  const command = await denialPoll;
  queue.submitResult(browserDigest, command.id, { ok: false, error: 'Control is not armed.' });
  response = await deniedCall;
  assert.equal(response.body.result._meta.code, 'browser_denied');
  assert.match(response.body.result.content[0].text, /Control is not armed/);

  const unavailablePoll = queue.poll(browserDigest, 100);
  const originalEnqueue = queue.enqueue;
  queue.enqueue = () => { throw new Error('synthetic persistence failure'); };
  response = await call(5, 'edge_wait', { ms: 1, timeoutMs: 500 });
  queue.enqueue = originalEnqueue;
  await unavailablePoll;
  assert.equal(response.body.result._meta.code, 'command_store_unavailable');
  assert.equal(response.body.result.content[0].text.includes('synthetic persistence failure'), false);
});

test('extension exposes a manually reversible control toggle and keeps executor refusal boundaries', () => {
  const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const executor = readFileSync(new URL('../extension/command-executor.js', import.meta.url), 'utf8');
  assert.match(html, /Turn browser control on/i);
  assert.match(html, /browser control is OFF/i);
  assert.match(html, /Leave OFF unless you want an agent to drive the page/);
  assert.doesNotMatch(html, /5 min|five.minute|expires automatically|Armed until/i);
  assert.doesNotMatch(html, /Keep this popup open[^<]*read/i);
  assert.match(popup, /toggle-browser-control/);
  assert.match(popup, /browser control is ON/);
  assert.match(popup, /browser control is OFF/);
  assert.match(popup, /polling === 'websocket'/);
  assert.match(popup, /WebSocket command channel active/);
  assert.match(popup, /polling === 'active'/);
  assert.match(popup, /Command polling active/);
  assert.match(popup, /polling === 'failed'/);
  assert.match(popup, /Starting command polling/);
  assert.match(popup, /setInterval\(refreshPairStatus/);
  assert.match(worker, /CONTROL_ENABLED_KEY/);
  assert.match(worker, /Control is not enabled\./);
  assert.doesNotMatch(worker, /ARM_EXPIRY_KEY|ARM_DURATION_MS|Date\.now\(\) \+.*CONTROL/);
  assert.match(worker, /startCommandPolling/);
  assert.match(worker, /COMMAND_POLL_HEARTBEAT_KEY/);
  assert.match(worker, /chrome\.storage\.session\.set\(\{ \[COMMAND_POLL_HEARTBEAT_KEY\]/);
  assert.match(executor, /data-work-edge-ref/);
  assert.match(executor, /password|passcode|mfa/);
  assert.match(executor, /send\|submit\|apply/);
  assert.doesNotMatch(executor, /\.defaultValue\b|getAttribute\(['"]value/);
});

test('pair codes are short-lived, single-use, persist only token verifiers, and authorize ingest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-pair-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'browser-tokens.json');
  const tokenStore = new PairedTokenStore({ filePath: tokenFile });
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const pairing = new PairingService({ tokenStore, now: () => now, ttlMs: 1_000 });
  const base = await start(createServer({ policy, devToken: 'admin-token', tokenStore, pairing, env: { WORK_EDGE_MCP_TOKEN: 'admin-token' } }), t); if (!base) return;

  assert.equal((await request(base, '/work-edge/pair/create', {})).status, 401);
  const created = await request(base, '/pair/create', {}, 'admin-token');
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^[A-Z2-9]{12}$/);
  assert.equal((await request(base, '/work-edge/pair/exchange', { code: 'BADBADBADBAD' })).status, 401);
  const exchanged = await request(base, '/work-edge/pair/exchange', { code: created.body.code });
  assert.equal(exchanged.status, 200);
  assert.equal(typeof exchanged.body.token, 'string');
  assert.equal((await request(base, '/pair/exchange', { code: created.body.code })).status, 401);
  assert.equal((await request(base, '/work-edge/ingest', capture(), 'wrong-paired-token')).status, 401);
  assert.equal((await request(base, '/work-edge/ingest', capture(), exchanged.body.token)).status, 202);
  assert.equal((await request(base, '/work-edge/pair/status', {}, exchanged.body.token)).status, 200);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const saved = readFileSync(tokenFile, 'utf8');
  assert.equal(saved.includes(exchanged.body.token), false);

  const stale = await request(base, '/pair/create', {}, 'admin-token');
  now += 1_001;
  assert.equal((await request(base, '/pair/exchange', { code: stale.body.code })).status, 401);
  assert.equal((await request(base, '/work-edge/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await request(base, '/work-edge/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'admin-token')).status, 200);
});
