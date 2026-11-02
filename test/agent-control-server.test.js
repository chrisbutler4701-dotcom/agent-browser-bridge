import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentControlLease } from '../broker/src/agent-control-lease.js';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } };
const digest = (token) => createHash('sha256').update(token).digest('hex');

async function mcp(server, token, id, name, args) {
  const response = await invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  return JSON.parse(response.body);
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-agent-control-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserTokenA = 'a'.repeat(32), browserTokenB = 'b'.repeat(32);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserTokenA); tokenStore.add(browserTokenB);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  const claude = agents.create({ id: 'claude-code', capabilities: ['browser.read', 'browser.control'] }).token;
  const codex = agents.create({ id: 'codex', capabilities: ['browser.read', 'browser.control'] }).token;
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const registry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const A = digest(browserTokenA), B = digest(browserTokenB);
  const browserA = registry.ensure(A), browserB = registry.ensure(B);
  queue.markOnline(A, true, '1.0.4'); queue.markOnline(B, true, '1.0.4');
  let now = 1_000_000;
  const agentControlLease = new AgentControlLease({ now: () => now, idleMs: 30_000 });
  const server = createServer({ policy, tokenStore, agentTokenStore: agents, commandQueue: queue, browserRegistry: registry, agentControlLease });
  t.after(() => server.close());
  return { server, queue, A, B, browserA, browserB, claude, codex, advance: (ms) => { now += ms; } };
}

async function act(server, queue, digestValue, token, id, args) {
  const poll = queue.poll(digestValue, 1_000, true, '1.0.4');
  const call = mcp(server, token, id, 'edge_scroll', args);
  const command = await poll;
  queue.submitResult(digestValue, command.id, { ok: true, result: {} });
  return { command, response: await call };
}

test('a second agent is told the browser is busy; the stamped command names the acting agent', async (t) => {
  const { server, queue, A, browserA, claude, codex } = setup(t);
  const first = await act(server, queue, A, claude, 1, { browserId: browserA.id, direction: 'down' });
  assert.equal(first.command.agentId, 'claude-code');
  assert.equal(first.response.result.isError, undefined);

  const busy = await mcp(server, codex, 2, 'edge_scroll', { browserId: browserA.id, direction: 'down' });
  assert.equal(busy.result.isError, true);
  assert.equal(busy.result._meta.code, 'agent_control_busy');
  const payload = JSON.parse(busy.result.content[0].text);
  assert.equal(payload.error.holder, 'claude-code');
  assert.ok(payload.error.retryAfterMs > 0);
});

test('reads are never blocked and bridge status names the holder for that browser', async (t) => {
  const { server, queue, A, browserA, claude, codex } = setup(t);
  await act(server, queue, A, claude, 1, { browserId: browserA.id, direction: 'down' });
  const status = await mcp(server, codex, 2, 'edge_bridge_status', { browserId: browserA.id });
  assert.equal(status.result.isError, undefined);
  assert.equal(JSON.parse(status.result.content[0].text).agentControl.holder, 'claude-code');
});

test('control passes to the other agent after the idle window', async (t) => {
  const { server, queue, A, browserA, claude, codex, advance } = setup(t);
  await act(server, queue, A, claude, 1, { browserId: browserA.id, direction: 'down' });
  advance(30_001);
  const second = await act(server, queue, A, codex, 2, { browserId: browserA.id, direction: 'down' });
  assert.equal(second.command.agentId, 'codex');
  assert.equal(second.response.result.isError, undefined);
});

test('two agents can act on two different browsers at the same time', async (t) => {
  const { server, queue, A, B, browserA, browserB, claude, codex } = setup(t);
  const pollA = queue.poll(A, 1_000, true, '1.0.4');
  const pollB = queue.poll(B, 1_000, true, '1.0.4');
  const callA = mcp(server, claude, 1, 'edge_scroll', { browserId: browserA.id, direction: 'down' });
  const callB = mcp(server, codex, 2, 'edge_scroll', { browserId: browserB.id, direction: 'down' });
  const [commandA, commandB] = await Promise.all([pollA, pollB]);
  assert.equal(commandA.agentId, 'claude-code');
  assert.equal(commandB.agentId, 'codex');
  queue.submitResult(A, commandA.id, { ok: true, result: {} });
  queue.submitResult(B, commandB.id, { ok: true, result: {} });
  assert.equal((await callA).result.isError, undefined);
  assert.equal((await callB).result.isError, undefined);
});
