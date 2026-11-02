import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from "node:test";
import { ReceiptStore } from '../broker/src/receipt-store.js';
import { TransactionStore } from '../broker/src/transaction-store.js';
import { sha256 } from "../broker/src/verified-action.js";
import { VerifiedActionRegistry } from "../broker/src/verified-action-registry.js";

function proposal(registry, id = "txn_registry") {
  return registry.propose({
    id,
    browserId: "browser_a",
    intent: "Update synthetic status",
    actor: { userId: "worker_1", agentId: "hermes" },
    target: { origin: "https://records.example.com", recordIdHash: "record_hash" },
    beforeHash: sha256({ status: "Unknown" }),
    changes: [{ field: "status", to: "Active" }],
  });
}

test("pending proposals are visible only to their bound browser", () => {
  const registry = new VerifiedActionRegistry();
  proposal(registry);
  assert.equal(registry.pendingForBrowser("browser_a").length, 1);
  assert.equal(registry.pendingForBrowser("browser_b").length, 0);
});

test("browser approval must include the exact proposal hash", () => {
  const registry = new VerifiedActionRegistry();
  const pending = proposal(registry);
  assert.throws(() => registry.approve("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: "0".repeat(64),
  }), /proposal hash does not match/);
  const approved = registry.approve("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: pending.proposalHash,
  });
  assert.equal(approved.phase, "approved");
});

test("a token from another paired browser cannot approve or execute", () => {
  const registry = new VerifiedActionRegistry();
  const pending = proposal(registry);
  assert.throws(() => registry.approve("txn_registry", {
    browserId: "browser_b", approverId: "worker_1", proposalHash: pending.proposalHash,
  }), /different browser/);
});

test("rejection is terminal and records the human decision", () => {
  const registry = new VerifiedActionRegistry();
  const pending = proposal(registry);
  const rejected = registry.reject("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: pending.proposalHash, reason: "Wrong client",
  });
  assert.equal(rejected.phase, "rejected");
  assert.equal(rejected.rejection.reason, "Wrong client");
  assert.throws(() => registry.approve("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: pending.proposalHash,
  }), /not awaiting approval/);
});

test("registry enforces browser binding through execution and verification", () => {
  const registry = new VerifiedActionRegistry();
  const pending = proposal(registry);
  const approved = registry.approve("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: pending.proposalHash,
  });
  registry.beginExecution("txn_registry", {
    browserId: "browser_a", proposal: approved.proposal, currentBeforeHash: approved.proposal.beforeHash,
  });
  const verified = registry.verify("txn_registry", {
    browserId: "browser_a", after: { status: "Active" }, persistedChanges: approved.proposal.changes,
  });
  assert.equal(verified.phase, "verified");
});

test("stale proposals disappear and cannot be approved", () => {
  let now = new Date("2026-09-12T12:00:00.000Z");
  const registry = new VerifiedActionRegistry({ clock: () => new Date(now), proposalTtlMs: 1000 });
  const pending = proposal(registry);
  now = new Date(now.getTime() + 1000);
  assert.equal(registry.pendingForBrowser("browser_a").length, 0);
  assert.throws(() => registry.approve("txn_registry", {
    browserId: "browser_a", approverId: "worker_1", proposalHash: pending.proposalHash,
  }), /proposal expired/);
});

function durableStores(t) {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-registry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    receiptStore: new ReceiptStore({ filePath: join(directory, 'receipts.json') }),
    transactionStore: new TransactionStore({ filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') }),
  };
}

test('approved transactions survive restart with the original approval boundary', (t) => {
  const stores = durableStores(t);
  const first = new VerifiedActionRegistry(stores);
  const pending = proposal(first, 'txn_restart_approved');
  first.approve('txn_restart_approved', {
    browserId: 'browser_a', approverId: 'worker_1', proposalHash: pending.proposalHash,
  });

  const restarted = new VerifiedActionRegistry(stores);
  const restored = restarted.get('txn_restart_approved');
  assert.equal(restored.phase, 'approved');
  assert.equal(restored.proposalHash, pending.proposalHash);
  restarted.beginExecution('txn_restart_approved', {
    browserId: 'browser_a', proposal: restored.proposal, currentBeforeHash: restored.proposal.beforeHash,
  });
  assert.equal(restarted.get('txn_restart_approved').phase, 'executing');
});

test('restart converts unresolved execution to indeterminate and never replays it', (t) => {
  const stores = durableStores(t);
  const first = new VerifiedActionRegistry(stores);
  const pending = proposal(first, 'txn_restart_executing');
  const approved = first.approve('txn_restart_executing', {
    browserId: 'browser_a', approverId: 'worker_1', proposalHash: pending.proposalHash,
  });
  first.beginExecution('txn_restart_executing', {
    browserId: 'browser_a', proposal: approved.proposal, currentBeforeHash: approved.proposal.beforeHash,
  });

  const restarted = new VerifiedActionRegistry(stores);
  const uncertain = restarted.get('txn_restart_executing');
  assert.equal(uncertain.phase, 'indeterminate');
  assert.match(uncertain.recovery.reason, /restarted/);
  assert.match(uncertain.recovery.next, /Do not replay/);
  assert.throws(() => restarted.beginExecution('txn_restart_executing', {
    browserId: 'browser_a', proposal: uncertain.proposal, currentBeforeHash: uncertain.proposal.beforeHash,
  }), /not approved/);
  assert.equal(new VerifiedActionRegistry(stores).get('txn_restart_executing').phase, 'indeterminate');
});

test('indeterminate execution can be resolved only by structured reconciliation', (t) => {
  const stores = durableStores(t);
  const registry = new VerifiedActionRegistry(stores);
  const pending = proposal(registry, 'txn_reconcile');
  const approved = registry.approve('txn_reconcile', {
    browserId: 'browser_a', approverId: 'worker_1', proposalHash: pending.proposalHash,
  });
  registry.beginExecution('txn_reconcile', {
    browserId: 'browser_a', proposal: approved.proposal, currentBeforeHash: approved.proposal.beforeHash,
  });
  registry.markIndeterminate('txn_reconcile', { browserId: 'browser_a', reason: 'Command acknowledgement timed out.' });
  const reconciled = registry.verify('txn_reconcile', {
    browserId: 'browser_a',
    after: { status: 'Active' },
    persistedChanges: approved.proposal.changes,
    method: 'reconciliation:structured-state',
  });
  assert.equal(reconciled.phase, 'verified');
  assert.equal(reconciled.receipt.verification.method, 'reconciliation:structured-state');
  assert.equal(new VerifiedActionRegistry(stores).get('txn_reconcile').phase, 'verified');
});
