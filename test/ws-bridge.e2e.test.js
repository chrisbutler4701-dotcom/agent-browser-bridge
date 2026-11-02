import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';

const digest = (token) => createHash('sha256').update(token).digest('hex');

const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['https://approved.example'],
  denyUrlPrefixes: ['edge://', 'chrome://', 'file://', 'about:'],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false }
};

async function start(server, t) {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('The sandbox does not permit loopback listeners.'); return null; }
    throw error;
  }
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, body, token = 'agent-token') {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function socketClient(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let failure = null;
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  socket.addEventListener('error', () => { failure ||= new Error('WebSocket client error'); });
  return {
    socket,
    async opened() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 2_000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(failure || new Error('WebSocket open failed')); }, { once: true });
      });
    },
    waitFor(predicate, timeoutMs = 2_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('WebSocket message timed out'));
        }, timeoutMs) };
        waiters.push(waiter);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
      socket.close();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  };
}

test('WebSocket bridge delivers durable commands, replays after reconnect, and completes idempotently', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'e2e-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, commandQueue, browserRegistry, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  const wsUrl = `${base.replace('http:', 'ws:')}/work-edge/ws`;

  const first = socketClient(wsUrl);
  t.after(() => first.close());
  await first.opened();
  first.socket.send(JSON.stringify({ type: 'hello', token, extensionVersion: '1.4.9', lastReceivedSeq: 0, lastCompletedSeq: 0 }));
  const firstHello = await first.waitFor((message) => message.type === 'hello');
  assert.equal(firstHello.ok, true);
  assert.equal(firstHello.browser.isDefault, true);
  assert.match(firstHello.browser.id, /^brw_[a-f0-9]{16}$/);
  browserRegistry.setAskBeforeFinalActions(firstHello.browser.id, false);

  const action = request(base, { jsonrpc: '2.0', id: 'wait-1', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1, timeoutMs: 2_000 } } });
  const delivered = await first.waitFor((message) => message.type === 'command');
  assert.equal(delivered.seq, 1);
  assert.equal(delivered.command.type, 'wait');
  assert.equal(delivered.command.ms, 1);
  await first.close();
  assert.equal(commandQueue.hasOnlineBrowser(digest(token)), false, 'a closed WebSocket must not leave a stale browser eligible for command timeouts');

  const second = socketClient(wsUrl);
  t.after(() => second.close());
  await second.opened();
  second.socket.send(JSON.stringify({ type: 'hello', token, extensionVersion: '1.4.9', lastReceivedSeq: 1, lastCompletedSeq: 0 }));
  await second.waitFor((message) => message.type === 'hello');
  const replayed = await second.waitFor((message) => message.type === 'command');
  assert.equal(replayed.seq, 1);
  assert.equal(replayed.command.id, delivered.command.id);
  second.socket.send(JSON.stringify({ type: 'result', id: replayed.command.id, ok: true, result: { waited: true }, lastReceivedSeq: 1, lastCompletedSeq: 1 }));
  const completed = await action;
  assert.equal(completed.status, 200);
  assert.deepEqual(JSON.parse(completed.body.result.content[0].text), { ok: true, result: { waited: true } });

  // A duplicate completion from a reconnecting browser must be harmless and must
  // not cause the completed command to be delivered again.
  second.socket.send(JSON.stringify({ type: 'result', id: replayed.command.id, ok: true, result: { waited: false }, lastReceivedSeq: 1, lastCompletedSeq: 1 }));
  const read = request(base, { jsonrpc: '2.0', id: 'read-bounded', method: 'tools/call', params: { name: 'edge_read_tab', arguments: { tabId: 2, maxCharacters: 400 } } });
  const readDelivery = await second.waitFor((message) => message.type === 'command' && message.command.type === 'read_tab');
  assert.equal(readDelivery.command.maxCharacters, 400);
  second.socket.send(JSON.stringify({ type: 'result', id: readDelivery.command.id, ok: true, result: { tabId: 2, capture: { text: 'x'.repeat(800) } } }));
  const readResult = await read;
  assert.equal(JSON.parse(readResult.body.result.content[0].text).result.capture.text.length, 400);
  const finalActionRequest = request(base, { jsonrpc: '2.0', id: 'free-save', method: 'tools/call', params: { name: 'edge_click', arguments: { targetText: 'Save changes', timeoutMs: 2_000 } } });
  const saveCommand = await second.waitFor((message) => message.type === 'command' && message.command.type === 'click');
  assert.equal(saveCommand.command.askBeforeFinalActions, false);
  second.socket.send(JSON.stringify({ type: 'result', id: saveCommand.command.id, ok: true, result: { clicked: true } }));
  const finalAction = await finalActionRequest;
  assert.equal(finalAction.status, 200);
  assert.equal(JSON.parse(finalAction.body.result.content[0].text).result.clicked, true);
  assert.equal(commandQueue.record(replayed.command.id).result.result.waited, true, 'the first result wins idempotently');
});

test('missed broker pong terminates the socket and marks its browser offline', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'field-browser-ping-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'ping-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  let heartbeat;
  const server = createServer({ policy, tokenStore, commandQueue, setHeartbeatInterval(callback, delay) {
    assert.equal(delay, 15_000);
    heartbeat = callback;
    return { unref() {} };
  } });
  const base = await start(server, t); if (!base) return;
  const client = socketClient(`${base.replace('http:', 'ws:')}/work-edge/ws`);
  t.after(() => client.close());
  await client.opened();
  client.socket.send(JSON.stringify({ type: 'hello', token, extensionVersion: '1.3.0', controlEnabled: true }));
  await client.waitFor((message) => message.type === 'hello' && message.ok);
  assert.equal(commandQueue.isOnline(digest(token)), true);
  heartbeat();
  heartbeat();
  assert.equal(commandQueue.isOnline(digest(token)), false);
});

test('revocation heartbeat closes a live browser, cancels commands, audits once, and rejects its next hello', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-revoke-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'live-revoked-browser-token';
  const browserDigest = digest(token);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'tokens.json') });
  tokenStore.add(token);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'registry.json') });
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  let heartbeat;
  const lines = [];
  const server = createServer({ policy: { ...policy, audit: { ...policy.audit, enabled: true } }, tokenStore, browserRegistry, commandQueue,
    auditWriter: (line) => lines.push(JSON.parse(line)),
    setHeartbeatInterval(callback) { heartbeat = callback; return { unref() {} }; }
  });
  const base = await start(server, t); if (!base) return;
  const url = `${base.replace('http:', 'ws:')}/work-edge/ws`;
  const client = socketClient(url);
  t.after(() => client.close());
  await client.opened();
  client.socket.send(JSON.stringify({ type: 'hello', token, extensionVersion: '1.3.0', controlEnabled: true }));
  const hello = await client.waitFor((message) => message.type === 'hello' && message.ok);
  assert.equal(commandQueue.isOnline(browserDigest), true);
  const command = { id: 'pending-revoked', type: 'wait', ms: 1, createdAt: new Date().toISOString() };
  commandQueue.enqueue(browserDigest, command);
  const pending = commandQueue.waitForResult(browserDigest, command.id, 2_000);
  const receivedCommand = { id: 'received-revoked', type: 'wait', ms: 1, createdAt: new Date().toISOString() };
  commandQueue.enqueue(browserDigest, receivedCommand);
  commandQueue.record(receivedCommand.id).state = 'received';
  const received = commandQueue.waitForResult(browserDigest, receivedCommand.id, 2_000);
  const closed = new Promise((resolve) => client.socket.addEventListener('close', resolve, { once: true }));
  const removed = JSON.parse(execFileSync(process.execPath, ['scripts/browser.js', 'remove', hello.browser.id], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, WORK_EDGE_TOKEN_STORE: tokenStore.filePath, WORK_EDGE_BROWSER_REGISTRY: browserRegistry.filePath },
    encoding: 'utf8'
  }));
  assert.deepEqual(removed, { removed: true, revoked: true, id: hello.browser.id, revokedInFlight: 'unknown' });
  heartbeat();
  await closed;
  assert.equal(commandQueue.isOnline(browserDigest), false);
  assert.equal(commandQueue.record(command.id).state, 'cancelled');
  assert.equal((await pending).code, 'browser_revoked');
  assert.equal(commandQueue.record(receivedCommand.id).state, 'revoked_in_flight');
  assert.equal((await received).code, 'revoked_in_flight');
  heartbeat();
  assert.deepEqual(lines.map((line) => line.event), ['browser_revoked']);
  assert.equal(lines[0].browserId, hello.browser.id);
  assert.equal(lines[0].cancelled, 1);
  assert.equal(lines[0].revokedInFlight, 1);
  assert.equal(JSON.stringify(lines).includes(token), false);
  assert.equal(JSON.stringify(lines).includes(browserDigest), false);

  const retry = socketClient(url);
  t.after(() => retry.close());
  await retry.opened();
  const rejected = new Promise((resolve) => retry.socket.addEventListener('close', resolve, { once: true }));
  retry.socket.send(JSON.stringify({ type: 'hello', token, extensionVersion: '1.3.0' }));
  await rejected;
  assert.equal(commandQueue.isOnline(browserDigest), false);
  assert.equal(browserRegistry.byDigest(browserDigest), null, 'rejected hello cannot re-register the browser');
});

test('WebSocket hello refuses stale, missing, and unparseable extension versions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-version-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'version-gate-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, tokenStore, commandQueue }), t); if (!base) return;
  const wsUrl = `${base.replace('http:', 'ws:')}/work-edge/ws`;
  const hello = async (extensionVersion) => {
    const client = socketClient(wsUrl);
    t.after(() => client.close());
    await client.opened();
    client.socket.send(JSON.stringify({ type: 'hello', token, ...(extensionVersion === undefined ? {} : { extensionVersion }) }));
    return client.waitFor((message) => message.type === 'hello');
  };

  for (const version of ['0.1.3', undefined, '0.1']) {
    const response = await hello(version);
    assert.equal(response.ok, false);
    assert.match(response.error, /minimum supported version 1\.0\.0/);
    assert.equal(commandQueue.hasOnlineBrowser(digest(token)), false);
  }
  assert.equal((await hello('1.0.0')).ok, true);
  assert.equal((await hello('99.0.0')).ok, true);
});

test('both browsers connect while the offline default never falls back to the healthy browser', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-selection-repair-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const defaultToken = 'synthetic-default-token';
  const secondToken = 'real-extension-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(defaultToken); tokenStore.add(secondToken);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const defaultBrowser = browserRegistry.ensure(digest(defaultToken));
  const secondBrowser = browserRegistry.ensure(digest(secondToken));
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  const wsUrl = `${base.replace('http:', 'ws:')}/work-edge/ws`;

  const second = socketClient(wsUrl);
  t.after(() => second.close());
  await second.opened();
  second.socket.send(JSON.stringify({ type: 'hello', token: secondToken, controlEnabled: true, extensionVersion: '1.0.0' }));
  assert.deepEqual(await second.waitFor((message) => message.type === 'hello'), { type: 'hello', ok: true, browser: secondBrowser });
  assert.equal(commandQueue.hasOnlineBrowser(digest(secondToken)), true);

  const offline = await request(base, { jsonrpc: '2.0', id: 'offline-default', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1 } } });
  assert.equal(offline.body.result._meta.code, 'browser_offline');
  assert.match(offline.body.result.content[0].text, new RegExp(defaultBrowser.id));

  const primary = socketClient(wsUrl);
  t.after(() => primary.close());
  await primary.opened();
  primary.socket.send(JSON.stringify({ type: 'hello', token: defaultToken, controlEnabled: true, extensionVersion: '1.0.0' }));
  assert.deepEqual(await primary.waitFor((message) => message.type === 'hello'), { type: 'hello', ok: true, browser: defaultBrowser });
  assert.equal(commandQueue.hasOnlineBrowser(digest(defaultToken)), true);
  assert.equal(commandQueue.hasOnlineBrowser(digest(secondToken)), true);

  await primary.close();
  const disconnected = await request(base, { jsonrpc: '2.0', id: 'disconnected-default', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1 } } });
  assert.equal(disconnected.body.result._meta.code, 'browser_offline');
  assert.equal(commandQueue.state.records.length, 0, 'the online second browser receives no default-browser command');
});

test('a completed WSS command recovers the next command through an authenticated polling lease after WSS loss', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-recovery-sequence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'recovery-sequence-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, commandQueue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tabId: 1, title: 'Watched inbox', url: 'https://approved.example/inbox', text: 'safe watch capture', elementSummary: [], userInitiated: false, readOnlyWatch: true, capturedAt: new Date().toISOString() })
  });
  const client = socketClient(`${base.replace('http:', 'ws:')}/work-edge/ws`);
  t.after(() => client.close());
  await client.opened();
  client.socket.send(JSON.stringify({ type: 'hello', token, controlEnabled: true, extensionVersion: '1.0.0', lastReceivedSeq: 0, lastCompletedSeq: 0 }));
  await client.waitFor((message) => message.type === 'hello');

  const first = request(base, { jsonrpc: '2.0', id: 'first-safe-wait', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1, timeoutMs: 2_000 } } });
  const firstDelivery = await client.waitFor((message) => message.type === 'command');
  client.socket.send(JSON.stringify({ type: 'command-received', id: firstDelivery.command.id, seq: firstDelivery.seq }));
  client.socket.send(JSON.stringify({ type: 'result', id: firstDelivery.command.id, ok: true, result: { waitedMs: 1, captureDelivered: false }, lastReceivedSeq: firstDelivery.seq, lastCompletedSeq: firstDelivery.seq }));
  assert.deepEqual(JSON.parse((await first).body.result.content[0].text), { ok: true, result: { waitedMs: 1, captureDelivered: false } });

  await client.close();
  assert.equal(commandQueue.hasOnlineBrowser(digest(token)), false, 'a closed WSS must release its old lease before recovery');
  const recoveryPoll = fetch(`${base}/work-edge/commands/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ waitMs: 1_000, controlEnabled: true, extensionVersion: '1.0.0' })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const recoveredStatus = await request(base, { jsonrpc: '2.0', id: 'recovery-status', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } });
  const bridge = JSON.parse(recoveredStatus.body.result.content[0].text);
  assert.equal(bridge.capture.capture, 'available', 'watch capture remains independent from command transport recovery');
  assert.equal(bridge.control.enabled, true);
  assert.equal(bridge.commandTransport.activePolling, true);
  assert.equal(bridge.commandTransport.healthy, true);

  const second = request(base, { jsonrpc: '2.0', id: 'second-safe-wait', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1, timeoutMs: 2_000 } } });
  const delivered = await (await recoveryPoll).json();
  assert.equal(delivered.command.type, 'wait');
  const result = await fetch(`${base}/work-edge/commands/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: delivered.command.id, ok: true, result: { waitedMs: 1 } })
  });
  assert.equal(result.status, 202);
  assert.deepEqual(JSON.parse((await second).body.result.content[0].text), { ok: true, result: { waitedMs: 1 } });
});

test('a command black-holed by an apparently live WebSocket fails transport health instead of timing out', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-blackhole-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'black-hole-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, tokenStore, commandQueue, commandAckTimeoutMs: 25, devToken: 'capture-token', env: { WORK_EDGE_MCP_TOKEN: 'capture-token' } }), t); if (!base) return;
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tabId: 1, title: 'Fresh inbox', url: 'https://approved.example/inbox', text: 'fresh capture', elementSummary: [], userInitiated: true, capturedAt: new Date().toISOString() })
  });
  const client = socketClient(`${base.replace('http:', 'ws:')}/work-edge/ws`);
  t.after(() => client.close());
  await client.opened();
  client.socket.send(JSON.stringify({ type: 'hello', token, controlEnabled: true, extensionVersion: '1.0.0', lastReceivedSeq: 0, lastCompletedSeq: 0 }));
  await client.waitFor((message) => message.type === 'hello');

  const before = await request(base, { jsonrpc: '2.0', id: 'before-blackhole', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } }, 'capture-token');
  const beforeStatus = JSON.parse(before.body.result.content[0].text);
  assert.equal(beforeStatus.websocketLiveOrRecent, true);
  assert.equal(beforeStatus.recentCommandPolling, false, 'a WebSocket must not be reported as HTTP command polling');

  const action = await request(base, { jsonrpc: '2.0', id: 'blackhole-command', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1, timeoutMs: 2_000 } } }, 'capture-token');
  assert.equal(action.body.result._meta.code, 'transport_unhealthy');
  const record = commandQueue.state.records.at(-1);
  assert.equal(record.state, 'failed');
  assert.equal(commandQueue.hasOnlineBrowser(digest(token)), false);
  assert.equal(commandQueue.controlEnabled(digest(token)), false);
  const after = await request(base, { jsonrpc: '2.0', id: 'after-blackhole', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } }, 'capture-token');
  const afterStatus = JSON.parse(after.body.result.content[0].text);
  assert.equal(afterStatus.websocketLiveOrRecent, false);
  assert.equal(afterStatus.control.enabled, false);
  assert.equal(afterStatus.capture.capture, 'available', 'fresh capture/read state must not be mistaken for command transport health');
});

test('an expired unconfirmed command degrades transport without changing the control toggle', async () => {
  let now = 0;
  const queue = new BrowserCommandQueue({ now: () => now, stateFile: null });
  queue.markOnline('browser', true);
  const command = { id: 'expires', type: 'wait', ms: 1, createdAt: new Date(now).toISOString() };
  const waiting = queue.waitForResult('browser', command.id, 1);
  queue.enqueue('browser', command, 1);
  now = 2;
  await waiting;
  assert.equal(queue.record(command.id).state, 'expired');
  assert.equal(queue.hasOnlineBrowser('browser'), true);
  assert.equal(queue.controlEnabled('browser'), true);
  assert.equal(queue.transportStatus('browser').degraded, true);
});

test('control enabled without a WebSocket or polling lease is diagnosed as recoverable transport loss', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-split-brain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'split-brain-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  browserRegistry.ensure(digest(token));
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;

  // A recent capture/heartbeat can preserve the control report after MV3 has
  // lost its WSS and before it has begun recovery polling.
  commandQueue.markOnline(digest(token), true, '0.1.0');
  const status = await request(base, { jsonrpc: '2.0', id: 'split-brain-status', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } });
  const bridge = JSON.parse(status.body.result.content[0].text);
  assert.equal(bridge.control.enabled, true);
  assert.equal(bridge.commandTransport.websocketLive, false);
  assert.equal(bridge.commandTransport.activePolling, false);
  assert.equal(bridge.commandTransport.healthy, false);
  assert.equal(bridge.commandTransport.degraded, true);
  assert.equal(bridge.commandTransport.failureReason, 'control_enabled_without_command_transport');

  const action = await request(base, { jsonrpc: '2.0', id: 'split-brain-wait', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1 } } });
  assert.equal(action.body.result._meta.code, 'no_online_browser');
  assert.match(action.body.result.content[0].text, /control_enabled_without_command_transport/);
});

test('a stale polling waiter cannot keep a live WebSocket status healthy after its command expires', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-ws-poll-blackhole-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'poll-black-hole-browser-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, commandQueue, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t); if (!base) return;
  const client = socketClient(`${base.replace('http:', 'ws:')}/work-edge/ws`);
  t.after(() => client.close());
  await client.opened();
  client.socket.send(JSON.stringify({ type: 'hello', token, controlEnabled: true, extensionVersion: '1.0.0', lastReceivedSeq: 0, lastCompletedSeq: 0 }));
  await client.waitFor((message) => message.type === 'hello');

  // This represents a poll request held by a worker that can no longer execute
  // or submit results. It makes the old status look healthy before the command.
  const poll = fetch(`${base}/commands/poll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ waitMs: 1_000, controlEnabled: true, extensionVersion: '1.0.0' }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = await request(base, { jsonrpc: '2.0', id: 'poll-blackhole-before', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } });
  const beforeStatus = JSON.parse(before.body.result.content[0].text);
  assert.equal(beforeStatus.commandTransport.websocketLive, true);
  assert.equal(beforeStatus.commandTransport.activePolling, true);
  assert.equal(beforeStatus.commandTransport.healthy, true);

  const action = await request(base, { jsonrpc: '2.0', id: 'poll-blackhole-command', method: 'tools/call', params: { name: 'edge_wait', arguments: { ms: 1, timeoutMs: 25 } } });
  assert.equal(action.body.result._meta.code, 'command_timeout');
  const delivered = await (await poll).json();
  assert.equal(delivered.command.type, 'wait', 'the poll response must contain the extension command shape');

  const after = await request(base, { jsonrpc: '2.0', id: 'poll-blackhole-after', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } });
  const afterStatus = JSON.parse(after.body.result.content[0].text);
  assert.equal(afterStatus.commandTransport.websocketLive, true);
  assert.equal(afterStatus.commandTransport.healthy, false, 'a waiter is not proof that it can execute and return a command result');
  assert.equal(afterStatus.control.enabled, true, 'a command timeout must not silently turn the user control toggle off');
});
