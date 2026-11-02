import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { ReceiptStore } from '../broker/src/receipt-store.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { TransactionStore } from '../broker/src/transaction-store.js';
import { sha256, VerifiedActionTransaction } from '../broker/src/verified-action.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['https://records.example.com'],
  denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false },
};

async function request(base, path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function start(server, t) {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('The sandbox does not permit loopback listeners.'); return null; }
    throw error;
  }
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function stores(t) {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-principals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    agentTokenStore: new AgentTokenStore({ filePath: join(directory, 'agents.json') }),
    tokenStore: new PairedTokenStore({ filePath: join(directory, 'browsers.json') }),
    browserRegistry: new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') }),
    commandQueue: new BrowserCommandQueue({ stateFile: '' }),
    receiptStore: new ReceiptStore({ filePath: join(directory, 'receipts.json') }),
    transactionStore: new TransactionStore({ filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') }),
  };
}

test('MCP stays closed before and after the first scoped credential and filters discovery and calls', async (t) => {
  const state = stores(t);
  const server = createServer({ policy, ...state, devToken: null, env: {} });
  const base = await start(server, t);
  if (!base) return;
  const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const bootstrap = await request(base, '/mcp', listRequest);
  assert.equal(bootstrap.status, 401);
  assert.equal(bootstrap.body.error.code, -32001);

  const readerToken = 'r'.repeat(32);
  state.agentTokenStore.add(readerToken, { id: 'reader', capabilities: ['browser.read'] });
  assert.equal((await request(base, '/mcp', listRequest)).status, 401);
  const scoped = await request(base, '/mcp', listRequest, readerToken);
  const names = scoped.body.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('edge_snapshot'), true);
  assert.equal(names.includes('edge_click'), false);
  const denied = await request(base, '/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_click', arguments: { selector: '#safe' } },
  }, readerToken);
  assert.equal(denied.body.error.code, -32003);
  assert.equal(denied.body.error.message, 'Agent capability denied');
  assert.equal(state.agentTokenStore.revoke('reader'), true);
  assert.equal((await request(base, '/mcp', listRequest)).status, 401);
});

test('verified proposals bind the authenticated agent and are isolated from peer agents', async (t) => {
  const state = stores(t);
  const proposerToken = 'p'.repeat(32);
  const peerToken = 'q'.repeat(32);
  state.agentTokenStore.add(proposerToken, { id: 'case-agent', capabilities: ['browser.verified.propose', 'browser.verified.execute'] });
  state.agentTokenStore.add(peerToken, { id: 'peer-agent', capabilities: ['browser.verified.propose'] });
  const browserToken = 'browser-token';
  state.tokenStore.add(browserToken);
  const browserId = createHash('sha256').update(browserToken).digest('hex');
  state.browserRegistry.ensure(browserId);
  const base = await start(createServer({ policy, ...state, devToken: null, env: {} }), t);
  if (!base) return;
  await request(base, '/ingest', {
    tabId: 42,
    title: 'Synthetic assessment',
    url: 'https://records.example.com/member/example',
    text: 'Synthetic record',
    elementSummary: [],
    userInitiated: true,
    capturedAt: new Date().toISOString(),
  }, browserToken);

  const change = { field: 'status', to: 'Active', control: 'type', locator: { selector: '[aria-label=Status]' } };
  const beforeHash = sha256([{ field: 'status', value: 'Unknown' }]);
  const poll = state.commandQueue.poll(browserId, 1_000, true, '1.0.0', 'polling_recovery_active');
  const inspectCall = request(base, '/mcp', {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'edge_verified_action_inspect', arguments: { changes: [change], commit: { targetText: 'Save assessment' } },
    },
  }, proposerToken);
  const command = await poll;
  state.commandQueue.submitResult(browserId, command.id, {
    ok: true,
    result: { currentBeforeHash: beforeHash, fields: ['status'], tabId: 42, origin: 'https://records.example.com' },
  });
  const inspection = JSON.parse((await inspectCall).body.result.content[0].text);
  const keepTransportOpen = state.commandQueue.poll(browserId, 500, true, '1.0.0', 'polling_recovery_active');
  const proposedResponse = await request(base, '/mcp', {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'edge_verified_action_propose', arguments: { intent: 'Update synthetic status', inspectionId: inspection.inspectionId },
    },
  }, proposerToken);
  const proposedPayload = JSON.parse(proposedResponse.body.result.content[0].text);
  assert.ok(proposedPayload.transaction, JSON.stringify(proposedPayload));
  const proposed = proposedPayload.transaction;
  await keepTransportOpen;
  assert.equal(proposed.proposal.actor.agentId, 'case-agent');

  const peerStatus = await request(base, '/mcp', {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
      name: 'edge_verified_action_status', arguments: { transactionId: proposed.proposal.transactionId },
    },
  }, peerToken);
  assert.equal(JSON.parse(peerStatus.body.result.content[0].text).error.code, 'transaction_not_found');
  const ownerStatus = await request(base, '/mcp', {
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
      name: 'edge_verified_action_status', arguments: { transactionId: proposed.proposal.transactionId },
    },
  }, proposerToken);
  assert.equal(JSON.parse(ownerStatus.body.result.content[0].text).proposal.actor.agentId, 'case-agent');
});

test('receipt ownership ignores non-authoritative actor metadata', async (t) => {
  const state = stores(t);
  const ownerToken = 'o'.repeat(32);
  const peerToken = 'z'.repeat(32);
  state.agentTokenStore.add(ownerToken, { id: 'case-agent', capabilities: ['browser.verified.propose'] });
  state.agentTokenStore.add(peerToken, { id: 'peer-agent', capabilities: ['browser.verified.propose'] });

  const transaction = new VerifiedActionTransaction({
    id: 'txn_actor_metadata',
    intent: 'Update synthetic status',
    actor: { agentId: 'case-agent', userId: 'worker-1' },
    target: { origin: 'https://records.example.com' },
    before: { status: 'Unknown' },
    changes: [{ field: 'status', to: 'Active' }],
  });
  const approved = transaction.approve({ approverId: 'worker-1' });
  transaction.beginExecution(approved.proposal, { status: 'Unknown' });
  transaction.verify({
    after: { status: 'Active' },
    persistedChanges: approved.proposal.changes,
    persistReceipt: (receipt) => state.receiptStore.append(receipt),
  });

  const base = await start(createServer({ policy, ...state, devToken: null, env: {} }), t);
  if (!base) return;
  const receiptCall = (token, id) => request(base, '/mcp', {
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'edge_verified_receipt', arguments: { transactionId: 'txn_actor_metadata' },
    },
  }, token);

  const owned = await receiptCall(ownerToken, 7);
  assert.equal(JSON.parse(owned.body.result.content[0].text).receipt.transactionId, 'txn_actor_metadata');
  const peer = await receiptCall(peerToken, 8);
  assert.equal(JSON.parse(peer.body.result.content[0].text).error.code, 'receipt_not_found');
});

test('owner recovery credential remains usable when the scoped credential store is damaged', async (t) => {
  const state = stores(t);
  writeFileSync(join(state.directory, 'agents.json'), '{broken');
  const ownerToken = 'owner-recovery-token';
  const base = await start(createServer({ policy, ...state, devToken: null, env: { WORK_EDGE_MCP_TOKEN: ownerToken } }), t);
  if (!base) return;
  const listed = await request(base, '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' }, ownerToken);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.tools.some((tool) => tool.name === 'edge_verified_action_execute'), true);
  const scopedFailure = await request(base, '/mcp', { jsonrpc: '2.0', id: 8, method: 'tools/list' }, 'x'.repeat(32));
  assert.equal(scopedFailure.status, 500);
});
