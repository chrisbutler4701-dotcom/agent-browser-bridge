import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['https://example.test'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false }, audit: { enabled: false } };

function fixture(t, version) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserToken = 'v'.repeat(32);
  const digest = createHash('sha256').update(browserToken).digest('hex');
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'tokens.json') });
  tokenStore.add(browserToken);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agents.json') });
  const agent = agents.create({ id: 'agent', capabilities: ['browser.read', 'browser.control'] }).token;
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const registry = new BrowserRegistry({ filePath: join(directory, 'registry.json') });
  const browser = registry.ensure(digest);
  queue.markOnline(digest, true, version);
  const server = createServer({ policy, tokenStore, agentTokenStore: agents, commandQueue: queue, browserRegistry: registry,
    env: { ...process.env, FBB_DATA_DIR: directory } });
  t.after(() => server.close());
  const call = async (name, args = {}) => JSON.parse((await invoke(server, { method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { browserId: browser.id, ...args } } }) })).body).result;
  const approvals = async () => JSON.parse((await invoke(server, { url: `/contract/v1/approvals?browserId=${browser.id}`, headers: { authorization: `Bearer ${agent}` } })).body).approvals;
  return { call, approvals, queue, digest, browser, registry };
}

test('old tab tool reports extension_outdated and queues nothing', async (t) => {
  const f = fixture(t, '1.0.9');
  const result = await f.call('edge_list_open_tabs');
  assert.equal(result._meta.code, 'extension_outdated');
  assert.match(result.content[0].text, /1\.1\.0/);
  assert.equal(f.queue.state.records.length, 0);
});

test('tab tool passes at 1.1.0 and unknown version is allowed', async (t) => {
  const f = fixture(t, '1.1.0');
  for (const version of ['1.1.0', null]) {
    if (version === null) f.queue.sessions.get(f.digest).extensionVersion = null;
    const pending = f.call('edge_list_open_tabs');
    const command = await f.queue.poll(f.digest, 1000, true);
    assert.equal(command.type, 'list_tabs');
    f.queue.submitResult(f.digest, command.id, { ok: true, result: { tabs: [] } });
    assert.equal((await pending).isError, undefined);
  }
});

test('extension 1.0.9 still dispatches a plain snapshot and live find', async (t) => {
  const f = fixture(t, '1.0.9');
  const snapshot = await f.call('edge_snapshot');
  assert.notEqual(snapshot._meta?.code, 'extension_outdated');

  const find = f.call('edge_find_elements', { selector: 'button', scope: 'live' });
  const command = await f.queue.poll(f.digest, 1000, true);
  assert.equal(command.type, 'find');
  f.queue.submitResult(f.digest, command.id, { ok: true, result: { matches: [] } });
  assert.equal((await find).isError, undefined);
});

test('extension 1.0.9 rejects per-tab snapshots', async (t) => {
  const f = fixture(t, '1.0.9');
  const result = await f.call('edge_snapshot', { tabId: 42 });
  assert.equal(result._meta.code, 'extension_outdated');
  assert.match(result.content[0].text, /1\.2\.0/);
  assert.equal(f.queue.state.records.length, 0);
});

test('extension 1.0.9 accepts targetText alone and rejects near', async (t) => {
  const f = fixture(t, '1.0.9');
  const click = f.call('edge_click', { targetText: 'Open details' });
  const command = await f.queue.poll(f.digest, 1000, true);
  assert.equal(command.type, 'click');
  assert.deepEqual(command.target, { targetText: 'Open details' });
  f.queue.submitResult(f.digest, command.id, { ok: true, result: {} });
  assert.equal((await click).isError, undefined);

  const scoped = await f.call('edge_click', { targetText: 'Open details', near: 'Job A' });
  assert.equal(scoped._meta.code, 'extension_outdated');
  assert.match(scoped.content[0].text, /1\.4\.9/);
});

test('extension 1.0.9 still dispatches scroll and wait', async (t) => {
  const f = fixture(t, '1.0.9');
  for (const [tool, args, type] of [
    ['edge_scroll', { direction: 'down' }, 'scroll'],
    ['edge_wait', { ms: 1 }, 'wait']
  ]) {
    const pending = f.call(tool, args);
    const command = await f.queue.poll(f.digest, 1000, true);
    assert.equal(command.type, type);
    f.queue.submitResult(f.digest, command.id, { ok: true, result: {} });
    assert.equal((await pending).isError, undefined);
  }
});

test('extension 1.4.5 cannot create a final-click approval', async (t) => {
  const f = fixture(t, '1.4.5');
  const result = await f.call('edge_click', { targetText: 'Share' });
  assert.equal(result._meta.code, 'extension_outdated');
  assert.equal(f.queue.state.records.length, 0);
  assert.deepEqual(await f.approvals(), []);
});
