import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { CaptureStore, createServer } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['*'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: true }, audit: { enabled: true, includeUrlPath: false } };
const png = 'iVBORw0KGgo=';

function fixture(t, screenshotEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'fbb-contract-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const digest = createHash('sha256').update('browser').digest('hex');
  const registry = new BrowserRegistry({ filePath: join(dir, 'registry.json') });
  const browser = registry.ensure(digest);
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const readKey = 'read-agent-key-long-enough-for-a-test-12345';
  const deniedKey = 'denied-agent-key-long-enough-for-test-1234';
  agents.add(readKey, { id: 'reader', capabilities: ['browser.read'] });
  agents.add(deniedKey, { id: 'denied', capabilities: ['browser.control'] });
  const store = new CaptureStore();
  const audits = [];
  const state = { online: true, capture: { tabId: 4, title: 'Saved', url: 'https://example.com/', text: 'saved', capturedAt: new Date(Date.now() - 10_000).toISOString() }, commands: [] };
  store.put(digest, state.capture);
  const queue = {
    isOnline: () => state.online, controlEnabled: () => true, hasActivePollingWaiter: () => true,
    transportStatus: () => ({ extensionVersion: '1.4.9', degraded: false }),
    enqueue(_digest, command) { state.commands.push(command); },
    async waitForResult(_digest, id) {
      const command = state.commands.find((item) => item.id === id);
      if (state.timeout) return null;
      if (command.type === 'list_tabs') return { ok: true, result: { frontTabId: 4 } };
      if (command.type === 'read_tab') {
        state.capture = { ...state.capture, title: 'Fresh', text: 'fresh', capturedAt: new Date().toISOString() };
        store.put(digest, state.capture);
        return { ok: true, result: { captureDelivered: true, capture: state.capture } };
      }
      if (command.type === 'screenshot') {
        store.putScreenshot(digest, { commandId: id, tabId: 4, data: png, capturedAt: new Date().toISOString() });
        return { ok: true, result: { tabId: 4 } };
      }
      return { ok: false };
    }
  };
  const server = createServer({ policy: { ...policy, capture: { ...policy.capture, screenshotEnabled } }, store, browserRegistry: registry, agentTokenStore: agents, commandQueue: queue, auditWriter: (line) => audits.push(line), env: { PUBLIC_BASE_URL: 'https://browser.example.com', FBB_DATA_DIR: dir } });
  t.after(() => server.close());
  const get = (path, key = readKey, version = '1') => invoke(server, { url: path, headers: { authorization: `Bearer ${key}`, 'fbb-contract-version': version } });
  const call = (name) => invoke(server, { method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${readKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { browserId: browser.id } } }) });
  return { browser, state, audits, get, call };
}

test('online reads refresh the front tab; offline and timeout reads mark saved content stale', async (t) => {
  const f = fixture(t);
  for (const name of ['edge_active_tab', 'edge_snapshot', 'edge_extract_text']) {
    const result = JSON.parse((await f.call(name)).body).result;
    const value = JSON.parse(result.content[0].text);
    assert.equal(name === 'edge_extract_text' ? value.text : value.title, name === 'edge_extract_text' ? 'fresh' : 'Fresh');
    assert.ok(value.capturedAt);
    assert.equal(value.stale, undefined);
  }
  const tabs = JSON.parse(JSON.parse((await f.call('edge_list_tabs')).body).result.content[0].text);
  assert.equal(tabs.result.frontTabId, 4);
  f.state.timeout = true;
  let value = JSON.parse(JSON.parse((await f.call('edge_snapshot')).body).result.content[0].text);
  assert.equal(value.stale, true); assert.ok(value.ageMs >= 0);
  f.state.online = false;
  value = JSON.parse(JSON.parse((await f.call('edge_active_tab')).body).result.content[0].text);
  assert.equal(value.stale, true); assert.ok(value.ageMs >= 0);
});

test('contract discovery, identity, status, auth, capability, unknown and offline errors', async (t) => {
  const f = fixture(t);
  const base = `/contract/v1/browsers/${f.browser.id}`;
  assert.equal(JSON.parse((await f.get('/contract/v1/browsers')).body).browsers[0].id, f.browser.id);
  assert.equal(JSON.parse((await f.get('/contract/v1/me')).body).agentId, 'reader');
  assert.equal(JSON.parse((await f.get(`${base}/status`)).body).activeTab.title, 'Saved');
  for (const path of ['/contract/v1/browsers', '/contract/v1/me', `${base}/status`, `${base}/screenshot`]) {
    assert.equal(JSON.parse((await f.get(path, '', '1')).body).error.code, 'unauthorized');
    assert.equal(JSON.parse((await f.get(path, 'denied-agent-key-long-enough-for-test-1234')).body).error.code, 'capability_denied');
    const version = await f.get(path, undefined, '2');
    assert.equal(version.status, 426); assert.equal(version.headers['fbb-supported-versions'], '1'); assert.equal(JSON.parse(version.body).error.code, 'contract_version_unsupported');
  }
  for (const route of ['status', 'screenshot']) {
    assert.equal(JSON.parse((await f.get(`/contract/v1/browsers/brw_deadbeefdeadbeef/${route}`)).body).error.code, 'browser_unknown');
    f.state.online = false;
    assert.equal(JSON.parse((await f.get(`${base}/${route}`)).body).error.code, 'browser_offline');
    f.state.online = true;
  }
});

test('contract screenshot returns a bound PNG, reuses it for one second, and does not audit frames', async (t) => {
  const f = fixture(t);
  const path = `/contract/v1/browsers/${f.browser.id}/screenshot`;
  const first = await f.get(path);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  assert.equal(first.headers['fbb-browser-id'], f.browser.id);
  assert.ok(first.headers['fbb-captured-at']);
  const second = await f.get(path);
  assert.equal(second.headers['fbb-captured-at'], first.headers['fbb-captured-at']);
  assert.equal(f.state.commands.filter((item) => item.type === 'screenshot').length, 1);
  assert.equal(f.audits.length, 0);
});

test('contract screenshot honors the broker screenshot policy', async (t) => {
  const f = fixture(t, false);
  const response = await f.get(`/contract/v1/browsers/${f.browser.id}/screenshot`);
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error.code, 'capability_denied');
  assert.equal(f.state.commands.length, 0);
});
