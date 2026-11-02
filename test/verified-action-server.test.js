import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserCommandQueue } from "../broker/src/command-queue.js";
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { ReceiptStore } from "../broker/src/receipt-store.js";
import { createServer, PairedTokenStore } from "../broker/src/server.js";
import { TransactionStore } from '../broker/src/transaction-store.js';
import { sha256 } from "../broker/src/verified-action.js";
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';

const policy = {
  listen: { host: "127.0.0.1", port: 0 },
  allowOrigins: ["https://records.example.com"],
  denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false },
};

async function request(base, path, body, token = 'agent-token') {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function start(server, t) {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM") { t.skip("The sandbox does not permit loopback listeners."); return null; }
    throw error;
  }
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("paired browser exclusively owns proposal approval", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "work-edge-verified-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = "browser-token";
  const browserId = createHash("sha256").update(token).digest("hex");
  const tokenStore = new PairedTokenStore({ filePath: join(directory, "tokens.json") });
  tokenStore.add(token);
  const queue = new BrowserCommandQueue({ stateFile: "" });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  browserRegistry.ensure(browserId);
  const receiptStore = new ReceiptStore({ filePath: join(directory, "receipts.json") });
  const transactionStore = new TransactionStore({ filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue: queue, receiptStore, transactionStore, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t);
  if (!base) return;

  const capture = {
    tabId: 42,
    title: "Synthetic assessment",
    url: "https://records.example.com/member/hashed-record",
    text: "Synthetic client only",
    elementSummary: [],
    userInitiated: true,
    capturedAt: new Date().toISOString(),
  };
  assert.equal((await request(base, "/ingest", capture, token)).status, 202);

  const change = { field: "housingStatus", to: "Currently housed", control: "type", locator: { selector: "[aria-label=Housing]" } };
  const beforeHash = sha256([{ field: "housingStatus", value: "Unknown" }]);
  const inspectPoll = queue.poll(browserId, 1_000, true, "1.0.0", "polling_recovery_active");
  const inspectCall = request(base, "/mcp", {
    jsonrpc: "2.0", id: "inspect", method: "tools/call", params: {
      name: "edge_verified_action_inspect", arguments: { changes: [change], commit: { targetText: "Save assessment" } },
    },
  });
  const inspectCommand = await inspectPoll;
  assert.equal(inspectCommand.type, "verified_preflight");
  queue.submitResult(browserId, inspectCommand.id, { ok: true, result: { currentBeforeHash: beforeHash, fields: ["housingStatus"], tabId: 42, origin: "https://records.example.com" } });
  const inspected = await inspectCall;
  const inspection = JSON.parse(inspected.body.result.content[0].text);
  assert.equal(inspection.beforeHash, beforeHash);

  const keepTransportOpen = queue.poll(browserId, 2_000, true, "1.0.0", "polling_recovery_active");
  const proposed = await request(base, "/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "edge_verified_action_propose",
      arguments: {
        intent: "Update synthetic housing status",
        inspectionId: inspection.inspectionId,
      },
    },
  });
  assert.equal(proposed.status, 200);
  const proposalResult = JSON.parse(proposed.body.result.content[0].text);
  assert.equal(proposalResult.approvalRequired, true);
  assert.equal(proposalResult.transaction.phase, "proposed");
  assert.equal(JSON.stringify(proposalResult).includes(browserId), false, "browser identity must not leak to MCP");

  assert.equal((await request(base, "/verified-actions/pending", {}, "wrong-token")).status, 401);
  const pending = await request(base, "/verified-actions/pending", {}, token);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.pending.length, 1);
  const transaction = pending.body.pending[0];

  const wrongHash = await request(base, "/verified-actions/approve", {
    transactionId: transaction.proposal.transactionId,
    proposalHash: "0".repeat(64),
  }, token);
  assert.equal(wrongHash.status, 400);

  const approved = await request(base, "/verified-actions/approve", {
    transactionId: transaction.proposal.transactionId,
    proposalHash: transaction.proposalHash,
  }, token);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.transaction.phase, "approved");

  const status = await request(base, "/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "edge_verified_action_status",
      arguments: { transactionId: transaction.proposal.transactionId },
    },
  });
  assert.equal(JSON.parse(status.body.result.content[0].text).phase, "approved");

  const wrongTargetCall = request(base, "/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "edge_verified_action_execute",
      arguments: { transactionId: transaction.proposal.transactionId },
    },
  });
  const wrongTargetPreflight = await keepTransportOpen;
  assert.equal(wrongTargetPreflight.type, "verified_preflight");
  queue.submitResult(browserId, wrongTargetPreflight.id, { ok: true, result: { currentBeforeHash: beforeHash, fields: ["housingStatus"], tabId: 43, origin: "https://records.example.com" } });
  const wrongTarget = await wrongTargetCall;
  assert.equal(wrongTarget.body.result.isError, true);
  assert.equal(wrongTarget.body.result._meta.code, "target_context_changed");

  const executionPreflightPoll = queue.poll(browserId, 2_000, true, "1.0.0", "polling_recovery_active");
  const secondExecutionPoll = queue.poll(browserId, 2_000, true, "1.0.0", "polling_recovery_active");
  const verificationPoll = queue.poll(browserId, 2_000, true, "1.0.0", "polling_recovery_active");
  const executionCall = request(base, "/mcp", {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "edge_verified_action_execute",
      arguments: { transactionId: transaction.proposal.transactionId },
    },
  });
  const executionPreflight = await executionPreflightPoll;
  assert.equal(executionPreflight.type, "verified_preflight");
  queue.submitResult(browserId, executionPreflight.id, { ok: true, result: { currentBeforeHash: beforeHash, fields: ["housingStatus"], tabId: 42, origin: "https://records.example.com" } });
  const applyCommand = await secondExecutionPoll;
  assert.equal(applyCommand.type, "verified_apply");
  assert.equal(applyCommand.approval.proposalHash, transaction.proposalHash);
  queue.submitResult(browserId, applyCommand.id, {
    ok: true, result: { committed: true },
  });
  const verifyCommand = await verificationPoll;
  assert.equal(verifyCommand.type, "verified_verify");
  queue.submitResult(browserId, verifyCommand.id, {
    ok: true, result: { persistedChanges: [{ field: "housingStatus", to: "Currently housed" }], method: "dom-value-after-commit" },
  });
  const executed = await executionCall;
  const executionResult = JSON.parse(executed.body.result.content[0].text);
  assert.equal(executionResult.ok, true);
  assert.equal(executionResult.transaction.phase, "verified");
  assert.equal(executionResult.transaction.verification.result, "persisted_match");

  const receiptResponse = await request(base, "/mcp", {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: {
      name: "edge_verified_receipt", arguments: { transactionId: transaction.proposal.transactionId },
    },
  });
  const durable = JSON.parse(receiptResponse.body.result.content[0].text);
  assert.equal(durable.chain.valid, true);
  assert.equal(durable.chain.count, 1);
});

test('ambiguous execution is never replayed and can be reconciled read-only', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-reconcile-server-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'browser-token';
  const browserId = createHash('sha256').update(token).digest('hex');
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'tokens.json') });
  tokenStore.add(token);
  const queue = new BrowserCommandQueue({ stateFile: '' });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  browserRegistry.ensure(browserId);
  const receiptStore = new ReceiptStore({ filePath: join(directory, 'receipts.json') });
  const transactionStore = new TransactionStore({ filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') });
  const verifiedActions = new VerifiedActionRegistry({ receiptStore, transactionStore });
  const changes = [{ field: 'housingStatus', to: 'Currently housed' }];
  const beforeHash = sha256([{ field: 'housingStatus', value: 'Unknown' }]);
  const pending = verifiedActions.propose({
    id: 'txn_server_reconcile',
    browserId,
    intent: 'Update synthetic housing status',
    actor: { agentId: 'mcp-client' },
    target: {
      origin: 'https://records.example.com',
      tabId: 42,
      tabIdHash: createHash('sha256').update('42').digest('hex'),
      operation: {
        steps: [{ ...changes[0], control: 'type', locator: { selector: '[aria-label=Housing]' } }],
        commit: { targetText: 'Save assessment' },
      },
    },
    beforeHash,
    changes,
  });
  verifiedActions.approve('txn_server_reconcile', {
    browserId, approverId: 'worker-1', proposalHash: pending.proposalHash,
  });
  const base = await start(createServer({ policy, devToken: 'agent-token', tokenStore, browserRegistry, commandQueue: queue, receiptStore, transactionStore, verifiedActions, env: { WORK_EDGE_MCP_TOKEN: 'agent-token' } }), t);
  if (!base) return;

  const preflightPoll = queue.poll(browserId, 2_000, true, '1.0.0', 'polling_recovery_active');
  const applyPoll = queue.poll(browserId, 2_000, true, '1.0.0', 'polling_recovery_active');
  const executionCall = request(base, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'edge_verified_action_execute', arguments: { transactionId: 'txn_server_reconcile', timeoutMs: 20 },
    },
  });
  const preflight = await preflightPoll;
  queue.submitResult(browserId, preflight.id, {
    ok: true,
    result: { currentBeforeHash: beforeHash, fields: ['housingStatus'], tabId: 42, origin: 'https://records.example.com' },
  });
  const apply = await applyPoll;
  assert.equal(apply.type, 'verified_apply');
  const uncertainResponse = await executionCall;
  const uncertain = JSON.parse(uncertainResponse.body.result.content[0].text);
  assert.equal(uncertainResponse.body.result._meta.code, 'execution_indeterminate');
  assert.equal(uncertain.error.transaction.phase, 'indeterminate');

  const reconcilePoll = queue.poll(browserId, 2_000, true, '1.0.0', 'polling_recovery_active');
  const reconcileCall = request(base, '/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'edge_verified_action_reconcile', arguments: { transactionId: 'txn_server_reconcile' },
    },
  });
  const reconcile = await reconcilePoll;
  assert.equal(reconcile.type, 'verified_verify');
  queue.submitResult(browserId, reconcile.id, {
    ok: true,
    result: { persistedChanges: changes, method: 'dom-value-after-commit', tabId: 42, origin: 'https://records.example.com' },
  });
  const reconciledResponse = await reconcileCall;
  const reconciled = JSON.parse(reconciledResponse.body.result.content[0].text);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.transaction.phase, 'verified');
  assert.equal(reconciled.transaction.verification.method, 'reconciliation:dom-value-after-commit');
});
