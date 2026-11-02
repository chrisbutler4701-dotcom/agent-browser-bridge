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

const policy = { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } };
const digest = (token) => createHash('sha256').update(token).digest('hex');

async function mcp(server, token, id, name, args = {}) {
  const response = await invoke(server, {
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
  return JSON.parse(response.body);
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-no-fallback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenA = 'a'.repeat(32), tokenB = 'b'.repeat(32);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(tokenA); tokenStore.add(tokenB);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  const agent = agents.create({ id: 'codex', capabilities: ['browser.read', 'browser.control'] }).token;
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const registry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const A = digest(tokenA), B = digest(tokenB);
  const browserA = registry.ensure(A), browserB = registry.ensure(B);
  queue.markOnline(A, true, '1.0.4'); queue.markOnline(B, true, '1.0.4');
  const server = createServer({ policy, tokenStore, agentTokenStore: agents, commandQueue: queue, browserRegistry: registry });
  t.after(() => server.close());
  return { server, agent, queue, registry, A, B, browserA, browserB };
}

async function completeScroll(server, agent, queue, browserDigest, id, args) {
  const poll = queue.poll(browserDigest, 1_000, true, '1.0.4');
  const call = mcp(server, agent, id, 'edge_scroll', args);
  const command = await poll;
  assert.equal(command.type, 'scroll');
  queue.submitResult(browserDigest, command.id, { ok: true, result: {} });
  assert.equal((await call).result.isError, undefined);
}

test('resolver targets only the default or explicitly named browser', async (t) => {
  const { server, agent, queue, A, B, browserB } = setup(t);
  await completeScroll(server, agent, queue, A, 1, { direction: 'down' });
  await completeScroll(server, agent, queue, B, 2, { browserId: browserB.id, direction: 'down' });
});

test('offline default never falls back to another online browser', async (t) => {
  const { server, agent, queue, A, B, browserA } = setup(t);
  queue.markOffline(A);
  const result = await mcp(server, agent, 1, 'edge_scroll', { direction: 'down' });
  assert.equal(result.result._meta.code, 'browser_offline');
  assert.match(result.result.content[0].text, new RegExp(browserA.id));
  assert.equal(await queue.poll(B, 50, true, '1.0.4'), null, 'no command is silently sent to B');
});

test('unknown browser and missing default fail explicitly', async (t) => {
  const { server, agent, registry, browserA } = setup(t);
  const unknown = await mcp(server, agent, 1, 'edge_scroll', { browserId: 'brw_0000000000000000', direction: 'down' });
  assert.equal(unknown.result._meta.code, 'browser_unknown');
  const unknownStatus = await mcp(server, agent, 11, 'edge_bridge_status', { browserId: 'brw_0000000000000000' });
  assert.equal(unknownStatus.result._meta.code, 'browser_unknown');
  registry.remove(browserA.id);
  const missing = await mcp(server, agent, 2, 'edge_scroll', { direction: 'down' });
  assert.equal(missing.result._meta.code, 'no_default_browser');
});

test('browser listing exposes public metadata without token digests', async (t) => {
  const { server, agent, queue, A, browserA, browserB } = setup(t);
  queue.markOffline(A);
  const response = await mcp(server, agent, 1, 'edge_list_browsers');
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.defaultBrowserId, browserA.id);
  assert.deepEqual(payload.browsers.map(({ id, online, isDefault }) => ({ id, online, isDefault })), [
    { id: browserA.id, online: false, isDefault: true },
    { id: browserB.id, online: true, isDefault: false }
  ]);
  assert.doesNotMatch(response.result.content[0].text, /[a-f0-9]{64}/);
});
