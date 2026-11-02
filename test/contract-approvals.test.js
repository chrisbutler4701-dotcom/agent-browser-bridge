import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { EventLog } from '../broker/src/event-log.js';
import { PasskeyStore } from '../broker/src/passkey-store.js';
import { createServer } from '../broker/src/server.js';
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';
import { invoke } from './http-harness.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['*'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includeUrlPath: false }
};
const origin = 'https://browser.example.test';
const rpId = 'browser.example.test';
const jsonHeaders = { 'content-type': 'application/json' };
const bearer = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });
const json = (response) => JSON.parse(response.body);
const body = (value) => JSON.stringify(value);

function softwarePasskey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = randomBytes(24).toString('base64url');
  return {
    credentialId,
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
    assertion(challenge, { count = 1, assertionOrigin = origin, assertionRpId = rpId, flags = 0x05 } = {}) {
      const clientBytes = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: assertionOrigin }));
      const counter = Buffer.alloc(4); counter.writeUInt32BE(count);
      const authBytes = Buffer.concat([createHash('sha256').update(assertionRpId).digest(), Buffer.from([flags]), counter]);
      const signed = Buffer.concat([authBytes, createHash('sha256').update(clientBytes).digest()]);
      return {
        credentialId,
        authenticatorData: authBytes.toString('base64url'),
        clientDataJSON: clientBytes.toString('base64url'),
        signature: sign('sha256', signed, privateKey).toString('base64url')
      };
    }
  };
}

function fixture(t, { proposalTtlMs = 10 * 60_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-contract-approvals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const browserDigest = 'a'.repeat(64);
  const agentToken = 'approval-agent-token-that-is-at-least-32-characters';
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const browser = browserRegistry.ensure(browserDigest);
  const agentTokenStore = new AgentTokenStore({ filePath: join(directory, 'agents.json') });
  agentTokenStore.add(agentToken, { id: 'approval-agent', capabilities: ['browser.read'] });
  const passkeyStore = new PasskeyStore({ filePath: join(directory, 'passkeys.json') });
  const passkey = softwarePasskey();
  passkeyStore.add({ credentialId: passkey.credentialId, publicKeyJwk: passkey.publicKeyJwk, signCount: 0, label: 'Owner phone' });
  const verifiedActions = new VerifiedActionRegistry({ clock: () => new Date(now), proposalTtlMs });
  const eventLog = new EventLog();
  const auditLines = [];
  const server = createServer({
    policy, agentTokenStore, browserRegistry, passkeyStore, verifiedActions, eventLog,
    auditWriter: (line) => auditLines.push(line),
    env: { PUBLIC_BASE_URL: origin, FBB_RP_ID: rpId, FBB_DATA_DIR: directory, FBB_PASSKEY_APPROVALS: '1' }
  });
  t.after(() => server.close());

  function propose(id = `txn-${randomBytes(4).toString('hex')}`) {
    return verifiedActions.propose({
      id, browserId: browserDigest, intent: 'Update housing status', actor: { agentId: 'approval-agent' },
      target: { origin: 'https://records.example.test', tabId: 7, tabIdHash: 'b'.repeat(64), operation: { steps: [], commit: { targetText: 'Save assessment' } } },
      before: { housingStatus: 'Unknown' },
      changes: [{ field: 'housingStatus', from: 'Unknown', to: 'Currently housed' }]
    });
  }

  async function challenge(transactionId) {
    return invoke(server, { method: 'POST', url: `/contract/v1/approvals/${transactionId}/challenge`, headers: jsonHeaders, body: '{}' });
  }

  async function decide(transaction, decision = 'approve', assertionPasskey = passkey) {
    const challengeResponse = await challenge(transaction.proposal.transactionId);
    assert.equal(challengeResponse.status, 200);
    const options = json(challengeResponse);
    const assertion = assertionPasskey.assertion(options.challenge);
    return invoke(server, {
      method: 'POST', url: `/contract/v1/approvals/${transaction.proposal.transactionId}`,
      headers: jsonHeaders,
      body: body({ decision, proposalHash: transaction.proposalHash, ...assertion })
    });
  }

  return { server, browser, browserDigest, agentToken, verifiedActions, eventLog, auditLines, passkey, propose, challenge, decide, advance(ms) { now += ms; } };
}

test('passkey approval routes are off by default and approval lists omit approveUrl', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-contract-approvals-off-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserDigest = 'c'.repeat(64);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const browser = browserRegistry.ensure(browserDigest);
  const agentTokenStore = new AgentTokenStore({ filePath: join(directory, 'agents.json') });
  const agentToken = 'approval-list-agent-token-at-least-32-characters';
  agentTokenStore.add(agentToken, { id: 'approval-list-agent', capabilities: ['browser.read'] });
  const verifiedActions = new VerifiedActionRegistry();
  verifiedActions.propose({
    id: 'txn-passkeys-off', browserId: browserDigest, intent: 'Update status', actor: { agentId: 'approval-list-agent' },
    target: { origin: 'https://records.example.test', tabId: 7, tabIdHash: 'd'.repeat(64), operation: { steps: [], commit: { targetText: 'Save' } } },
    before: { status: 'old' }, changes: [{ field: 'status', from: 'old', to: 'new' }]
  });
  const server = createServer({
    policy, agentTokenStore, browserRegistry, verifiedActions,
    env: { PUBLIC_BASE_URL: origin, FBB_RP_ID: rpId, FBB_DATA_DIR: directory }
  });
  t.after(() => server.close());

  const listed = await invoke(server, { url: `/contract/v1/approvals?browserId=${browser.id}`, headers: bearer(agentToken) });
  assert.equal(listed.status, 200);
  assert.equal(Object.hasOwn(json(listed).approvals[0], 'approveUrl'), false);
  for (const request of [
    { url: '/approve/txn-passkeys-off' },
    { method: 'POST', url: '/contract/v1/approvals/txn-passkeys-off/challenge', headers: jsonHeaders, body: '{}' },
    { method: 'POST', url: '/contract/v1/approvals/txn-passkeys-off', headers: jsonHeaders, body: '{}' },
    { url: '/work-edge/owner/passkeys' },
    { method: 'POST', url: '/work-edge/owner/passkeys/list', headers: jsonHeaders, body: '{}' }
  ]) assert.equal((await invoke(server, request)).status, 404, request.url);
});

test('approval list, page, challenge, and passkey approval use the existing verified action registry', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-approve');
  const listed = await invoke(state.server, { url: `/contract/v1/approvals?browserId=${state.browser.id}`, headers: bearer(state.agentToken) });
  assert.equal(listed.status, 200);
  assert.equal(json(listed).approvals.length, 1);
  assert.equal(json(listed).approvals[0].proposal.transactionId, 'txn-approve');
  assert.equal(json(listed).approvals[0].approveUrl, `${origin}/approve/txn-approve`);

  const page = await invoke(state.server, { url: '/approve/txn-approve' });
  assert.equal(page.status, 200);
  assert.match(page.body, /Update housing status/);
  assert.match(page.body, /Currently housed/);
  assert.match(page.body, /Approve with passkey/);
  assert.match(page.body, /Reject with passkey/);
  assert.match(page.body, /navigator\.credentials\.get/);
  assert.match(page.body, /role="status"/);

  const approved = await state.decide(transaction);
  assert.equal(approved.status, 200);
  assert.equal(json(approved).transaction.phase, 'approved');
  assert.equal(state.verifiedActions.get('txn-approve').phase, 'approved');
  assert.match(state.verifiedActions.get('txn-approve').approval.approverId, /^owner-passkey:/);
});

test('a passkey approval challenge is single use', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-replay');
  const challenge = json(await state.challenge('txn-replay'));
  const request = { decision: 'approve', proposalHash: transaction.proposalHash, ...state.passkey.assertion(challenge.challenge) };
  const first = await invoke(state.server, { method: 'POST', url: '/contract/v1/approvals/txn-replay', headers: jsonHeaders, body: body(request) });
  const replay = await invoke(state.server, { method: 'POST', url: '/contract/v1/approvals/txn-replay', headers: jsonHeaders, body: body(request) });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 401);
  assert.deepEqual(json(replay), { error: { code: 'passkey_invalid', message: 'The passkey assertion was invalid or already used.' } });
  assert.equal(state.verifiedActions.get('txn-replay').phase, 'approved');
});

test('approval refuses a changed proposal hash and an expired proposal', async (t) => {
  const changed = fixture(t);
  const changedTransaction = changed.propose('txn-changed');
  const changedChallenge = json(await changed.challenge('txn-changed'));
  const changedResponse = await invoke(changed.server, {
    method: 'POST', url: '/contract/v1/approvals/txn-changed', headers: jsonHeaders,
    body: body({ decision: 'approve', proposalHash: '0'.repeat(64), ...changed.passkey.assertion(changedChallenge.challenge) })
  });
  assert.equal(changedResponse.status, 409);
  assert.deepEqual(json(changedResponse), { error: { code: 'proposal_changed', message: 'The proposal changed after this approval page was opened.' } });
  assert.equal(changed.verifiedActions.get(changedTransaction.proposal.transactionId).phase, 'proposed');

  const expired = fixture(t, { proposalTtlMs: 50 });
  const expiredTransaction = expired.propose('txn-expired');
  const expiredChallenge = json(await expired.challenge('txn-expired'));
  expired.advance(51);
  const expiredResponse = await invoke(expired.server, {
    method: 'POST', url: '/contract/v1/approvals/txn-expired', headers: jsonHeaders,
    body: body({ decision: 'approve', proposalHash: expiredTransaction.proposalHash, ...expired.passkey.assertion(expiredChallenge.challenge) })
  });
  assert.equal(expiredResponse.status, 410);
  assert.deepEqual(json(expiredResponse), { error: { code: 'approval_expired', message: 'This approval request expired.' } });
});

test('the decision route ignores bearer credentials and requires a registered passkey assertion', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-auth');
  await state.challenge('txn-auth');
  const bearerOnly = await invoke(state.server, {
    method: 'POST', url: '/contract/v1/approvals/txn-auth', headers: bearer(state.agentToken),
    body: body({ decision: 'approve', proposalHash: transaction.proposalHash })
  });
  assert.equal(bearerOnly.status, 401);
  assert.deepEqual(json(bearerOnly), { error: { code: 'passkey_required', message: 'Approve or reject with a registered passkey.' } });

  const challenge = json(await state.challenge('txn-auth'));
  const stranger = softwarePasskey();
  const unregistered = await invoke(state.server, {
    method: 'POST', url: '/contract/v1/approvals/txn-auth', headers: jsonHeaders,
    body: body({ decision: 'approve', proposalHash: transaction.proposalHash, ...stranger.assertion(challenge.challenge) })
  });
  assert.equal(unregistered.status, 401);
  assert.equal(json(unregistered).error.code, 'passkey_invalid');
  assert.equal(state.verifiedActions.get('txn-auth').phase, 'proposed');
});

test('approval rejects assertions for the wrong origin, rpId, or without user verification', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-assertion-boundary');
  const invalidOptions = [
    { assertionOrigin: 'https://wrong.example.test' },
    { assertionRpId: 'wrong.example.test' },
    { flags: 0x01 }
  ];
  for (const options of invalidOptions) {
    const challenge = json(await state.challenge(transaction.proposal.transactionId));
    const response = await invoke(state.server, {
      method: 'POST', url: `/contract/v1/approvals/${transaction.proposal.transactionId}`, headers: jsonHeaders,
      body: body({ decision: 'approve', proposalHash: transaction.proposalHash, ...state.passkey.assertion(challenge.challenge, options) })
    });
    assert.equal(response.status, 401);
    assert.equal(json(response).error.code, 'passkey_invalid');
    assert.equal(state.verifiedActions.get(transaction.proposal.transactionId).phase, 'proposed');
  }
});

test('reject uses the same passkey ceremony', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-reject');
  const rejected = await state.decide(transaction, 'reject');
  assert.equal(rejected.status, 200);
  assert.equal(json(rejected).transaction.phase, 'rejected');
  assert.equal(state.verifiedActions.get('txn-reject').phase, 'rejected');
});

test('approval decision writes one safe audit line and one approval_decided event', async (t) => {
  const state = fixture(t);
  const transaction = state.propose('txn-audit');
  const approved = await state.decide(transaction);
  assert.equal(approved.status, 200);
  const entries = state.auditLines.map((line) => JSON.parse(line)).filter((entry) => entry.tool === 'approval_decision');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'txn-audit');
  const audit = state.auditLines.join('');
  assert.equal(audit.includes(state.passkey.credentialId), false);
  assert.equal(audit.includes(state.passkey.publicKeyJwk.x), false);
  const events = state.eventLog.since(state.browserDigest, '0').events.filter((event) => event.type === 'approval_decided');
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, 'owner');
  assert.equal(events[0].ok, true);
});
