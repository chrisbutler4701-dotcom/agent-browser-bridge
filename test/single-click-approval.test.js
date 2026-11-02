import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { ApproverStore } from '../broker/src/approver-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { ReceiptStore } from '../broker/src/receipt-store.js';
import { TransactionStore } from '../broker/src/transaction-store.js';
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';
import { sha256 } from '../broker/src/verified-action.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['https://example.test'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false } };
const browserToken = createHash('sha256').update('single-click-browser').digest('hex');
const agentKey = 'single-click-agent-key-with-at-least-32-characters';
const json = (reply) => JSON.parse(reply.body);
const headers = (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-single-click-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const browser = registry.ensure(browserToken);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agents.json') });
  agents.add(agentKey, { id: 'gemma', capabilities: ['browser.read', 'browser.control', 'manage_browser_privacy'] });
  const approvers = new ApproverStore({ filePath: join(directory, 'approvers.json') });
  const approver = approvers.create({ label: 'Owner' });
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'tokens.json') });
  tokenStore.add('single-click-browser');
  const receipts = new ReceiptStore({ filePath: join(directory, 'receipts.json') });
  const queue = new BrowserCommandQueue({ stateFile: '' });
  const server = createServer({ policy, agentTokenStore: agents, approverStore: approvers, tokenStore, browserRegistry: registry,
    commandQueue: queue, receiptStore: receipts,
    env: { PUBLIC_BASE_URL: 'https://bridge.example.test', FBB_DATA_DIR: directory, FBB_APPROVAL_WAIT_SECONDS: '1' } });
  t.after(() => server.close());
  const call = (name, args) => invoke(server, { method: 'POST', url: '/mcp', headers: headers(agentKey),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { browserId: browser.id, ...args } } }) });
  const poll = () => queue.poll(browserToken, 2500, true, '1.4.9', 'polling_recovery_active');
  const pending = () => invoke(server, { url: `/contract/v1/approvals?browserId=${browser.id}`, headers: headers(agentKey) });
  const decide = (approval, decision) => invoke(server, { method: 'POST', url: `/contract/v1/approvals/${approval.proposal.transactionId}/decision`,
    headers: headers(approver.key), body: JSON.stringify({ decision, proposalHash: approval.proposalHash, approver: 'Owner' }) });
  const popup = (approval, decision, route = '') => invoke(server, { method: 'POST', url: `${route}/verified-actions/${decision}`,
    headers: headers('single-click-browser'), body: JSON.stringify({ transactionId: approval.proposal.transactionId, proposalHash: approval.proposalHash }) });
  return { directory, registry, browser, queue, receipts, agents, approvers, approverKey: approver.key, tokenStore, call, poll, pending, decide, popup, server };
}
async function startFinalClick(state, args = {}) {
  const first = state.poll();
  const called = state.call('edge_click', { targetText: 'Send', ...args });
  const inspection = await first;
  assert.equal(inspection.type, 'inspect_action');
  state.queue.submitResult(browserToken, inspection.id, { ok: true, result: {
    finalAction: true, name: 'Send', fingerprint: 'abc12345', url: 'https://example.test/inbox', title: 'Inbox | Handshake', tabId: 7,
  } });
  let listed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    listed = json(await state.pending()).approvals;
    if (listed.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(listed.length, 1);
  assert.equal(listed[0].proposal.target.kind, 'single_click');
  return { called, approval: listed[0] };
}

test('approval uses a permitted actor label while keeping the principal id', async (t) => {
  const state = fixture(t);
  const { approval } = await startFinalClick(state, { actorLabel: 'Gemma via Cockpit' });
  assert.match(approval.proposal.intent, /^Gemma via Cockpit wants to click "Send"/u);
  assert.equal(approval.proposal.actor.displayLabel, 'Gemma via Cockpit');
  assert.equal(approval.proposal.actor.agentId, 'gemma');
});

test('final click waits for approval, executes once, and writes a chained receipt', async (t) => {
  const state = fixture(t);
  const { called, approval } = await startFinalClick(state);
  assert.match(approval.proposal.intent, /gemma wants to click "Send" on Inbox \| Handshake/);
  const second = state.poll();
  assert.equal((await state.decide(approval, 'approve')).status, 200);
  const command = await second;
  assert.equal(command.type, 'click');
  assert.equal(command.approvalBinding.transactionId, approval.proposal.transactionId);
  assert.equal(command.seenPages, undefined, 'an approved click must not be re-gated by look-first state from proposal time');
  state.queue.submitResult(browserToken, command.id, { ok: true, result: { clicked: true } });
  assert.equal(JSON.parse(json(await called).result.content[0].text).code, 'approval_pending');
  assert.deepEqual(JSON.parse(json(await state.call('edge_approval_wait', { approvalId: approval.proposal.transactionId, waitMs: 100 })).result.content[0].text),
    { status: 'approved', result: { clicked: true } });
  assert.deepEqual(JSON.parse(json(await state.call('edge_approval_wait', { approvalId: approval.proposal.transactionId, waitMs: 0 })).result.content[0].text),
    { status: 'approved' });
  assert.equal((await state.decide(approval, 'approve')).status, 410);
  assert.equal(state.queue.state.records.filter((item) => item.command.type === 'click').length, 1);
  assert.equal(state.receipts.verifyChain().count, 1);
});

test('final word click with near binds the inspected control ref for approval', async (t) => {
  const state = fixture(t);
  const inspectPoll = state.poll();
  const called = state.call('edge_click', { targetText: 'Share', near: 'Junior AI Engineer' });
  const inspect = await inspectPoll;
  assert.deepEqual(inspect.target, { targetText: 'Share', near: 'Junior AI Engineer' });
  state.queue.submitResult(browserToken, inspect.id, { ok: true, result: {
    finalAction: true, name: 'Share', tag: 'button', ref: 'work-edge-share-2', fingerprint: 'abc12345',
    url: 'https://example.test/jobs', title: 'Jobs', context: 'Junior AI Engineer', tabId: 7,
  } });
  const response = json(await called).result;
  assert.equal(JSON.parse(response.content[0].text).code, 'approval_pending');
  assert.equal(JSON.parse(response.content[0].text).context, 'Junior AI Engineer');
  const approvals = json(await state.pending()).approvals;
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].proposal.target.operation.commit, { ref: 'work-edge-share-2' });
  assert.equal(approvals[0].proposal.target.context, 'Junior AI Engineer');
  assert.match(approvals[0].proposal.intent, /on "Junior AI Engineer" \(Jobs\)/u);
  const poll = state.poll();
  await state.decide(approvals[0], 'approve');
  const approved = await poll;
  assert.deepEqual(approved.target, { ref: 'work-edge-share-2' });
  state.queue.submitResult(browserToken, approved.id, { ok: true, result: { clicked: true } });
});

test('broker final classification creates approval when extension inspection says non-final', async (t) => {
  const state = fixture(t);
  const first = state.poll();
  const called = state.call('edge_click', { targetText: 'Share this job' });
  const inspection = await first;
  assert.equal(inspection.type, 'inspect_action');
  assert.equal(inspection.finalAction, true);
  state.queue.submitResult(browserToken, inspection.id, { ok: true, result: {
    finalAction: false, name: 'Share', tag: 'div', fingerprint: 'abc12345',
    url: 'https://example.test/jobs', title: 'Jobs | Handshake', tabId: 7,
  } });
  const pending = JSON.parse(json(await called).result.content[0].text);
  assert.equal(pending.code, 'approval_pending');
  const approvals = json(await state.pending()).approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].proposal.target.kind, 'single_click');
  assert.equal(state.queue.state.records.filter((item) => item.command.type === 'click').length, 0);
});

test('paired-browser popup approval executes once and popup rejection declines', async (t) => {
  const approved = fixture(t);
  const first = await startFinalClick(approved);
  const polled = approved.poll();
  assert.equal((await approved.popup(first.approval, 'approve', '/work-edge')).status, 200);
  const command = await polled;
  assert.equal(command.type, 'click');
  approved.queue.submitResult(browserToken, command.id, { ok: true, result: { clicked: true } });
  assert.equal(JSON.parse(json(await approved.call('edge_approval_wait', { approvalId: first.approval.proposal.transactionId, waitMs: 100 })).result.content[0].text).status, 'approved');
  assert.equal((await approved.popup(first.approval, 'approve')).status, 400);
  assert.equal(approved.queue.state.records.filter((item) => item.command.type === 'click').length, 1);

  const rejected = fixture(t);
  const second = await startFinalClick(rejected);
  assert.equal((await rejected.popup(second.approval, 'reject')).status, 200);
  assert.equal(JSON.parse(json(await rejected.call('edge_approval_wait', { approvalId: second.approval.proposal.transactionId, waitMs: 0 })).result.content[0].text).status, 'declined');
  assert.equal(rejected.queue.state.records.filter((item) => item.command.type === 'click').length, 0);
});

test('approval after broker restart fails without dispatching a click', async (t) => {
  const state = fixture(t);
  const { approval } = await startFinalClick(state);
  const restartedQueue = new BrowserCommandQueue({ stateFile: '' });
  const restarted = createServer({ policy, agentTokenStore: state.agents, approverStore: state.approvers,
    tokenStore: state.tokenStore, browserRegistry: state.registry, commandQueue: restartedQueue,
    receiptStore: new ReceiptStore({ filePath: join(state.directory, 'receipts.json') }),
    env: { PUBLIC_BASE_URL: 'https://bridge.example.test', FBB_DATA_DIR: state.directory, FBB_APPROVAL_WAIT_SECONDS: '1' } });
  t.after(() => restarted.close());
  const decision = await invoke(restarted, { method: 'POST', url: `/contract/v1/approvals/${approval.proposal.transactionId}/decision`,
    headers: headers(state.approverKey),
    body: JSON.stringify({ decision: 'approve', proposalHash: approval.proposalHash, approver: 'Owner' }) });
  assert.equal(decision.status, 200);
  const waited = await invoke(restarted, { method: 'POST', url: '/mcp', headers: headers(agentKey),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edge_approval_wait', arguments: { approvalId: approval.proposal.transactionId, waitMs: 0 } } }) });
  assert.deepEqual(JSON.parse(json(waited).result.content[0].text),
    { status: 'failed', error: 'The bridge restarted before this action ran; nothing was clicked.' });
  assert.equal(restartedQueue.state.records.filter((item) => item.command.type === 'click').length, 0);
});

test('waiting on a restored approved click without a pending binding fails', async (t) => {
  const state = fixture(t);
  const { approval } = await startFinalClick(state);
  const receipts = new ReceiptStore({ filePath: join(state.directory, 'receipts.json') });
  const verifiedActions = new VerifiedActionRegistry({ receiptStore: receipts,
    transactionStore: new TransactionStore({ filePath: join(state.directory, 'verified-action-transactions.json'),
      keyFile: join(state.directory, 'verified-action-transactions.key') }) });
  verifiedActions.approve(approval.proposal.transactionId, { browserId: browserToken, approverId: 'Owner', proposalHash: approval.proposalHash });
  const queue = new BrowserCommandQueue({ stateFile: '' });
  const restarted = createServer({ policy, agentTokenStore: state.agents, browserRegistry: state.registry,
    commandQueue: queue, verifiedActions, receiptStore: receipts,
    env: { PUBLIC_BASE_URL: 'https://bridge.example.test', FBB_DATA_DIR: state.directory } });
  t.after(() => restarted.close());
  const waited = await invoke(restarted, { method: 'POST', url: '/mcp', headers: headers(agentKey),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edge_approval_wait', arguments: { approvalId: approval.proposal.transactionId, waitMs: 0 } } }) });
  assert.deepEqual(JSON.parse(json(waited).result.content[0].text),
    { status: 'failed', error: 'The bridge restarted before this action ran; nothing was clicked.' });
  assert.equal(verifiedActions.get(approval.proposal.transactionId).phase, 'failed');
  assert.equal(queue.state.records.filter((item) => item.command.type === 'click').length, 0);
});

test('final click returns pending promptly and wait is scoped to its requester', async (t) => {
  const state = fixture(t);
  const started = Date.now();
  const { called, approval } = await startFinalClick(state);
  const pending = JSON.parse(json(await called).result.content[0].text);
  assert.ok(Date.now() - started < 2000);
  assert.equal(pending.code, 'approval_pending');
  assert.equal(pending.approvalId, approval.proposal.transactionId);
  assert.equal(json(await called).result.isError, true);
  const waiting = JSON.parse(json(await state.call('edge_approval_wait', { approvalId: pending.approvalId, waitMs: 10 })).result.content[0].text);
  assert.equal(waiting.status, 'pending');
  const otherKey = 'another-agent-key-with-at-least-32-characters';
  state.agents.add(otherKey, { id: 'other', capabilities: ['browser.control'] });
  const denied = await invoke(state.server, { method: 'POST', url: '/mcp', headers: headers(otherKey),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_approval_wait', arguments: { approvalId: pending.approvalId, waitMs: 0 } } }) });
  assert.equal(JSON.parse(json(denied).result.content[0].text).error.code, 'approval_not_found');
});

test('changed page after approval does not click and records failure', async (t) => {
  const state = fixture(t);
  const { called, approval } = await startFinalClick(state);
  const second = state.poll();
  assert.equal((await state.decide(approval, 'approve')).status, 200);
  const command = await second;
  state.queue.submitResult(browserToken, command.id, { ok: false, error: 'The page changed; nothing was clicked.' });
  assert.equal(JSON.parse(json(await called).result.content[0].text).code, 'approval_pending');
  assert.match(JSON.parse(json(await state.call('edge_approval_wait', { approvalId: approval.proposal.transactionId, waitMs: 100 })).result.content[0].text).error, /page changed/);
  assert.equal(state.receipts.verifyChain().count, 1);
});

test('final-action URL waits before opening a tab', async (t) => {
  const state = fixture(t);
  const first = state.poll();
  const called = state.call('edge_open_tab', { url: 'https://example.test/checkout' });
  const inspection = await first;
  assert.equal(inspection.type, 'inspect_action');
  assert.equal(inspection.finalNavigation, true);
  state.queue.submitResult(browserToken, inspection.id, { ok: true, result: { finalAction: true,
    name: 'https://example.test/checkout', fingerprint: 'abc12345', url: 'https://example.test/cart', title: 'Cart', tabId: 7 } });
  let approvals;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    approvals = json(await state.pending()).approvals;
    if (approvals.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(approvals.length, 1);
  const second = state.poll();
  assert.equal((await state.decide(approvals[0], 'approve')).status, 200);
  const opening = await second;
  assert.equal(opening.type, 'open_tab');
  assert.equal(opening.approvalBinding.requestedUrl, 'https://example.test/checkout');
  state.queue.submitResult(browserToken, opening.id, { ok: true, result: { tabId: 8 } });
  assert.equal(JSON.parse(json(await called).result.content[0].text).code, 'approval_pending');
  assert.equal(JSON.parse(json(await state.call('edge_approval_wait', { approvalId: approvals[0].proposal.transactionId, waitMs: 100 })).result.content[0].text).status, 'approved');
});

test('decline and timeout leave the browser untouched and write receipts', async (t) => {
  const declined = fixture(t);
  const first = await startFinalClick(declined);
  assert.equal((await declined.decide(first.approval, 'reject')).status, 200);
  assert.equal(JSON.parse(json(await first.called).result.content[0].text).code, 'approval_pending');
  assert.equal(JSON.parse(json(await declined.call('edge_approval_wait', { approvalId: first.approval.proposal.transactionId, waitMs: 10 })).result.content[0].text).status, 'declined');
  assert.equal(declined.queue.state.records.filter((item) => item.command.type === 'click').length, 0);
  assert.equal(declined.receipts.verifyChain().count, 1);
  const expired = fixture(t);
  const second = await startFinalClick(expired);
  assert.equal(JSON.parse(json(await second.called).result.content[0].text).code, 'approval_pending');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(JSON.parse(json(await expired.call('edge_approval_wait', { approvalId: second.approval.proposal.transactionId, waitMs: 10 })).result.content[0].text).status, 'expired');
  assert.equal(expired.queue.state.records.filter((item) => item.command.type === 'click').length, 0);
  assert.equal(expired.receipts.verifyChain().count, 1);
});

test('ask-off browser sends the click directly and private browsers cannot turn asking off', async (t) => {
  const state = fixture(t);
  const change = (askBeforeFinalActions) => invoke(state.server, { method: 'POST', url: '/agent-grants/final-actions',
    headers: headers(agentKey), body: JSON.stringify({ browserId: state.browser.id, askBeforeFinalActions }) });
  assert.equal((await change(false)).status, 200);
  const listed = json(await invoke(state.server, { url: '/contract/v1/browsers', headers: { ...headers(agentKey), 'fbb-contract-version': '1' } }));
  assert.equal(listed.browsers[0].askBeforeFinalActions, false);
  const first = state.poll();
  const called = state.call('edge_click', { targetText: 'Send' });
  const command = await first;
  assert.equal(command.type, 'click');
  assert.equal(command.askBeforeFinalActions, false);
  state.queue.submitResult(browserToken, command.id, { ok: true, result: { clicked: true } });
  assert.equal(JSON.parse(json(await called).result.content[0].text).ok, true);
  state.registry.setPrivate(state.browser.id, true);
  assert.equal(state.registry.byId(state.browser.id), browserToken);
  assert.equal(state.registry.byDigest(browserToken).askBeforeFinalActions, true);
  assert.throws(() => state.registry.setAskBeforeFinalActions(state.browser.id, false), /Private browsers/);
  assert.equal((await change(false)).status, 400);
});

test('Cockpit credential can create an approver link with browser-settings authority', async (t) => {
  const state = fixture(t);
  const created = await invoke(state.server, { method: 'POST', url: '/agent-grants/approver', headers: headers(agentKey),
    body: JSON.stringify({ label: 'Cockpit owner' }) });
  assert.equal(created.status, 200);
  assert.match(json(created).id, /^apr_/);
  assert.equal(typeof json(created).key, 'string');
});

test('an expired click is receipted when the broker restores its transaction store', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-single-click-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.now();
  const receipts = new ReceiptStore({ filePath: join(directory, 'receipts.json') });
  const transactions = new TransactionStore({ filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') });
  const options = { clock: () => new Date(now), receiptStore: receipts, transactionStore: transactions };
  const first = new VerifiedActionRegistry(options);
  first.propose({ id: 'click-restart', browserId: browserToken, intent: 'Send', actor: { agentId: 'gemma' },
    target: { kind: 'single_click', expiresAt: new Date(now + 1000).toISOString(), origin: 'https://example.test', operation: { commit: { targetText: 'Send' } } },
    beforeHash: sha256('before'), changes: [{ field: 'Action', to: 'Send' }] });
  now += 2000;
  const restored = new VerifiedActionRegistry(options);
  assert.equal(restored.get('click-restart').phase, 'rejected');
  assert.equal(receipts.get('click-restart').status, 'expired');
  assert.equal(receipts.verifyChain().count, 1);
});
