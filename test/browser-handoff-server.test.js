import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } };

async function start(server, t) {
  t.after(() => server.close());
  return server;
}

async function call(base, path, { method = 'POST', body, token, controller } = {}) {
  const response = await invoke(base, { method, url: path, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(controller ? { 'x-test-controller': controller } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

test('authenticated takeover blocks direct MCP mutations, preserves human control, then resumes extension commands', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-handoff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserToken = 'b'.repeat(32);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const verifiedActions = new VerifiedActionRegistry();
  const base = await start(createServer({ policy, devToken: 'owner-token', tokenStore, browserRegistry, commandQueue: queue, verifiedActions, handoffControllerAuthenticator: (req) => ({ id: req.headers['x-test-controller'] }), env: { WORK_EDGE_MCP_TOKEN: 'owner-token' } }), t);
  const browserId = (await import('node:crypto')).createHash('sha256').update(browserToken).digest('hex');
  browserRegistry.ensure(browserId);
  const firstPoll = queue.poll(browserId, 1_000, true, '1.0.0');
  const initial = call(base, '/mcp', { token: 'owner-token', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edge_type', arguments: { selector: '[role=textbox]', text: 'ordinary work' } } } });
  const firstCommand = await firstPoll;
  assert.equal(firstCommand.type, 'type', 'no claim leaves ordinary tools unrestricted');
  queue.submitResult(browserId, firstCommand.id, { ok: true, result: { typed: true } });
  assert.equal((await initial).body.result.isError, undefined);

  const status = await call(base, '/work-edge/browser/handoff', { method: 'GET', controller: 'human-a' });
  assert.equal(status.status, 200);
  assert.equal(status.body.browserInstance, browserId);
  assert.equal(status.body.controllerIdentity, null);
  assert.equal(status.body.activeAgentIdentity, 'owner-bootstrap');
  const claimed = await call(base, '/work-edge/browser/handoff/claim', { controller: 'human-a', body: {} });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.controllerIdentity, 'human-a');

  const denied = await call(base, '/mcp', { token: 'owner-token', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_type', arguments: { selector: '[role=textbox]', text: 'not-delivered' } } } });
  assert.equal(denied.body.result._meta.code, 'human_takeover_active');
  const proposed = verifiedActions.propose({ browserId, id: 'takeover-test-transaction', intent: 'Synthetic checked change', actor: { agentId: 'owner-bootstrap' }, target: { tabId: 1, tabIdHash: 'x', origin: 'https://approved.example', operation: { steps: [], commit: { selector: '[role=button]' } } }, before: 'private-before-value', changes: [{ field: 'synthetic', to: 'new', control: 'type', locator: { selector: '[role=textbox]' } }] });
  verifiedActions.approve('takeover-test-transaction', { browserId, approverId: 'paired-human', proposalHash: proposed.proposalHash });
  const verifiedDenied = await call(base, '/mcp', { token: 'owner-token', body: { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'edge_verified_action_execute', arguments: { transactionId: 'takeover-test-transaction' } } } });
  assert.equal(verifiedDenied.body.result._meta.code, 'human_takeover_active', 'verified execution uses the same takeover dispatch guard');
  assert.equal((await call(base, '/work-edge/browser/handoff/release', { controller: 'human-b', body: {} })).status, 409);
  assert.equal((await call(base, '/work-edge/browser/handoff/release', { controller: 'human-a', body: {} })).status, 200);

  const resumedPoll = queue.poll(browserId, 1_000, true, '1.0.0');
  const resumed = call(base, '/mcp', { token: 'owner-token', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edge_type', arguments: { selector: '[role=textbox]', text: 'resumed' } } } });
  const resumedCommand = await resumedPoll;
  assert.equal(resumedCommand.type, 'type');
  queue.submitResult(browserId, resumedCommand.id, { ok: true, result: { typed: true } });
  assert.equal((await resumed).body.result.isError, undefined);
});
