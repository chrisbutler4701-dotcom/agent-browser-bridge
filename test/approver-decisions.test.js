import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { EventLog } from '../broker/src/event-log.js';
import { OwnerSessions } from '../broker/src/owner-session.js';
import { createServer } from '../broker/src/server.js';
import { sha256 } from '../broker/src/verified-action.js';
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';
import { invoke } from './http-harness.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['https://records.example.test'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includeUrlPath: false }
};
const jsonHeaders = { 'content-type': 'application/json' };
const bearer = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });
const body = (value) => JSON.stringify(value);
const json = (response) => JSON.parse(response.body);

function fixture(t, { proposalTtlMs = 10 * 60_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-approver-decisions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const browserDigest = 'a'.repeat(64);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const browser = browserRegistry.ensure(browserDigest);
  const agentTokenStore = new AgentTokenStore({ filePath: join(directory, 'agents.json'), clock: () => new Date(now) });
  const agentToken = 'approval-agent-token-that-is-at-least-32-characters';
  agentTokenStore.add(agentToken, { id: 'approval-agent', capabilities: ['browser.read', 'browser.verified.execute'] });
  const ownerSessions = new OwnerSessions({ passphrase: 'owner passphrase for approvals', now: () => now, delay: async () => {} });
  const verifiedActions = new VerifiedActionRegistry({ clock: () => new Date(now), proposalTtlMs });
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json'), now: () => now });
  const eventLog = new EventLog({ now: () => new Date(now) });
  const auditLines = [];
  const server = createServer({
    policy, agentTokenStore, ownerSessions, browserRegistry, verifiedActions, commandQueue, eventLog,
    auditWriter: (line) => auditLines.push(line),
    env: { PUBLIC_BASE_URL: 'https://browser.example.test', FBB_DATA_DIR: directory }
  });
  t.after(() => server.close());

  function propose(id) {
    return verifiedActions.propose({
      id, browserId: browserDigest, intent: 'Update housing status', actor: { agentId: 'approval-agent' },
      target: {
        origin: 'https://records.example.test', tabId: 7,
        tabIdHash: createHash('sha256').update('7').digest('hex'),
        operation: {
          steps: [{ field: 'housingStatus', to: 'Currently housed', control: 'type', locator: { selector: '#housing-status' } }],
          commit: { targetText: 'Save assessment' }
        }
      },
      beforeHash: sha256([{ field: 'housingStatus', value: 'Unknown' }]),
      changes: [{ field: 'housingStatus', to: 'Currently housed' }]
    });
  }

  async function ownerToken() {
    return (await ownerSessions.signIn({ passphrase: 'owner passphrase for approvals', ip: '127.0.0.1' })).token;
  }

  async function createApprover(label = 'Cockpit office') {
    const response = await invoke(server, {
      method: 'POST', url: '/work-edge/owner/approvers', headers: bearer(await ownerToken()), body: body({ label })
    });
    assert.equal(response.status, 201);
    return json(response);
  }

  async function decide(key, transaction, decision = 'approve', proposalHash = transaction.proposalHash, approver = 'owner') {
    return invoke(server, {
      method: 'POST', url: `/contract/v1/approvals/${transaction.proposal.transactionId}/decision`,
      headers: bearer(key), body: body({ decision, proposalHash, approver })
    });
  }

  return {
    directory, server, browser, browserDigest, browserRegistry, agentToken, verifiedActions, commandQueue, eventLog,
    auditLines, propose, ownerToken, createApprover, decide, advance(ms) { now += ms; }
  };
}

test('owner creates, lists, and revokes hashed private approver credentials', async (t) => {
  const state = fixture(t);
  const session = await state.ownerToken();
  const created = await state.createApprover();
  assert.deepEqual(Object.keys(created).sort(), ['id', 'key', 'label']);
  assert.match(created.id, /^apr_[a-f0-9]{16}$/);
  assert.equal(created.label, 'Cockpit office');
  assert.ok(created.key.length >= 43);
  const storePath = join(state.directory, 'approvers.json');
  const stored = readFileSync(storePath, 'utf8');
  assert.equal(stored.includes(created.key), false);
  assert.equal(statSync(storePath).mode & 0o777, 0o600);

  const listed = await invoke(state.server, { method: 'POST', url: '/work-edge/owner/approvers/list', headers: bearer(session), body: '{}' });
  assert.equal(listed.status, 200);
  assert.equal(json(listed).approvers.length, 1);
  assert.equal(json(listed).approvers[0].id, created.id);
  assert.equal(json(listed).approvers[0].label, created.label);
  assert.equal(typeof json(listed).approvers[0].createdAt, 'string');
  const revoked = await invoke(state.server, { method: 'POST', url: '/work-edge/owner/approvers/revoke', headers: bearer(session), body: body({ id: created.id }) });
  assert.equal(revoked.status, 200);
  assert.deepEqual(json(revoked), { revoked: true });
  const transaction = state.propose('txn-revoked');
  const refused = await state.decide(created.key, transaction);
  assert.equal(refused.status, 401);
  assert.deepEqual(json(refused), { error: { code: 'unauthorized', message: 'Provide a valid approval credential.' } });
});

test('approver keys cannot call MCP and agent keys cannot decide approvals', async (t) => {
  const state = fixture(t);
  const created = await state.createApprover();
  const transaction = state.propose('txn-isolation');
  const mcp = await invoke(state.server, {
    method: 'POST', url: '/mcp', headers: bearer(created.key),
    body: body({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(mcp.status, 401);
  const decision = await state.decide(state.agentToken, transaction);
  assert.equal(decision.status, 401);
  assert.deepEqual(json(decision), { error: { code: 'unauthorized', message: 'Provide a valid approval credential.' } });
  assert.equal(state.verifiedActions.get('txn-isolation').phase, 'proposed');
});

test('an approver can approve and the owning agent can execute the exact proposal', async (t) => {
  const state = fixture(t);
  const created = await state.createApprover();
  const transaction = state.propose('txn-execute');
  const approved = await state.decide(created.key, transaction);
  assert.equal(approved.status, 200);
  assert.equal(json(approved).transaction.phase, 'approved');

  state.commandQueue.markOnline(state.browserDigest, true, '1.0.8', 'polling_recovery_active');
  const preflightPoll = state.commandQueue.poll(state.browserDigest, 2_000, true, '1.0.8', 'polling_recovery_active');
  const applyPoll = state.commandQueue.poll(state.browserDigest, 2_000, true, '1.0.8', 'polling_recovery_active');
  const verifyPoll = state.commandQueue.poll(state.browserDigest, 2_000, true, '1.0.8', 'polling_recovery_active');
  const call = invoke(state.server, {
    method: 'POST', url: '/mcp', headers: bearer(state.agentToken),
    body: body({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_verified_action_execute', arguments: { browserId: state.browser.id, transactionId: 'txn-execute' } } })
  });
  const preflight = await preflightPoll;
  state.commandQueue.submitResult(state.browserDigest, preflight.id, { ok: true, result: { currentBeforeHash: transaction.proposal.beforeHash, tabId: 7, origin: 'https://records.example.test' } });
  const apply = await applyPoll;
  state.commandQueue.submitResult(state.browserDigest, apply.id, { ok: true, result: { committed: true } });
  const verify = await verifyPoll;
  state.commandQueue.submitResult(state.browserDigest, verify.id, { ok: true, result: { persistedChanges: [{ field: 'housingStatus', to: 'Currently housed' }], method: 'dom-value-after-commit' } });
  const executed = json(await call);
  assert.equal(JSON.parse(executed.result.content[0].text).transaction.phase, 'verified');
});

test('reject is terminal and concurrent decisions land exactly once', async (t) => {
  const state = fixture(t);
  const created = await state.createApprover();
  const rejected = state.propose('txn-reject');
  const rejectResponse = await state.decide(created.key, rejected, 'reject');
  assert.equal(rejectResponse.status, 200);
  assert.equal(json(rejectResponse).transaction.phase, 'rejected');

  const concurrent = state.propose('txn-concurrent');
  const responses = await Promise.all([
    state.decide(created.key, concurrent, 'approve'),
    state.decide(created.key, concurrent, 'approve')
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410]);
  assert.equal(json(responses.find((response) => response.status === 410)).error.code, 'approval_expired');
  assert.equal(state.verifiedActions.get('txn-concurrent').phase, 'approved');
});

test('decision errors preserve the proposal and use the contract error shape', async (t) => {
  const state = fixture(t, { proposalTtlMs: 50 });
  const created = await state.createApprover();
  const changed = state.propose('txn-changed');
  const changedResponse = await state.decide(created.key, changed, 'approve', '0'.repeat(64));
  assert.equal(changedResponse.status, 409);
  assert.equal(json(changedResponse).error.code, 'proposal_changed');
  assert.equal(state.verifiedActions.get('txn-changed').phase, 'proposed');

  const expired = state.propose('txn-expired');
  state.advance(51);
  const expiredResponse = await state.decide(created.key, expired);
  assert.equal(expiredResponse.status, 410);
  assert.equal(json(expiredResponse).error.code, 'approval_expired');

  const unknown = await state.decide(created.key, { proposal: { transactionId: 'txn-unknown' }, proposalHash: '1'.repeat(64) });
  assert.equal(unknown.status, 410);
  assert.equal(json(unknown).error.code, 'approval_expired');

  const missingBrowser = state.propose('txn-browser-gone');
  state.browserRegistry.remove(state.browser.id);
  const browserResponse = await state.decide(created.key, missingBrowser);
  assert.equal(browserResponse.status, 404);
  assert.equal(json(browserResponse).error.code, 'browser_unknown');
  assert.equal(state.verifiedActions.get('txn-browser-gone').phase, 'proposed');
});

test('approval decisions emit one safe audit line and one browser event', async (t) => {
  const state = fixture(t);
  const created = await state.createApprover('Cockpit phone');
  const transaction = state.propose('txn-audit');
  const response = await state.decide(created.key, transaction, 'approve', transaction.proposalHash, 'owner');
  assert.equal(response.status, 200);
  const entries = state.auditLines.map((line) => JSON.parse(line)).filter((entry) => entry.tool === 'approval_decision');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].agentId, `cockpit:${created.id}`);
  assert.equal(entries[0].target, 'txn-audit');
  assert.equal(entries[0].approver, 'owner');
  const audit = state.auditLines.join('');
  assert.equal(audit.includes(created.key), false);
  const events = state.eventLog.since(state.browserDigest, '0').events.filter((event) => event.type === 'approval_decided');
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, `cockpit:${created.id}`);
});

test('ApproverStore authenticates only active keys and exposes no key material from list', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-approver-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { ApproverStore } = await import('../broker/src/approver-store.js');
  const store = new ApproverStore({ filePath: join(directory, 'approvers.json'), clock: () => new Date('2030-01-01T00:00:00.000Z') });
  const created = store.create({ label: 'Cockpit main' });
  assert.deepEqual(store.authenticate(created.key), { id: created.id, label: 'Cockpit main' });
  assert.deepEqual(store.list(), [{ id: created.id, label: 'Cockpit main', createdAt: '2030-01-01T00:00:00.000Z' }]);
  assert.equal(store.revoke(created.id), true);
  assert.equal(store.authenticate(created.key), null);
  assert.equal(store.list()[0].revokedAt, '2030-01-01T00:00:00.000Z');
});
