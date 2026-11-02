import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReceiptStore } from '../broker/src/receipt-store.js';
import { VerifiedActionRegistry } from '../broker/src/verified-action-registry.js';
import { sha256 } from '../broker/src/verified-action.js';

function complete(registry, id) {
  const pending = registry.propose({
    id, browserId: 'browser_a', intent: `Complete ${id}`,
    actor: { agentId: 'test' }, target: { origin: 'https://records.example.com' },
    beforeHash: sha256({ status: 'Unknown' }), changes: [{ field: 'status', to: 'Active' }],
  });
  const approved = registry.approve(id, { browserId: 'browser_a', approverId: 'worker_1', proposalHash: pending.proposalHash });
  registry.beginExecution(id, { browserId: 'browser_a', proposal: approved.proposal, currentBeforeHash: approved.proposal.beforeHash });
  return registry.verify(id, { browserId: 'browser_a', after: { status: 'Active' }, persistedChanges: approved.proposal.changes });
}

test('durable receipts form and validate a real append-only chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-receipts-'));
  try {
    const filePath = join(directory, 'receipts.json');
    const store = new ReceiptStore({ filePath });
    const registry = new VerifiedActionRegistry({ receiptStore: store });
    const first = complete(registry, 'txn_first');
    const second = complete(registry, 'txn_second');
    assert.equal(first.receipt.previousReceiptHash, null);
    assert.equal(second.receipt.previousReceiptHash, first.receipt.receiptHash);
    assert.deepEqual(store.verifyChain(), { valid: true, count: 2, head: second.receipt.receiptHash });
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('receipt store fails closed when a durable receipt is altered', () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-receipt-tamper-'));
  try {
    const filePath = join(directory, 'receipts.json');
    const store = new ReceiptStore({ filePath });
    const registry = new VerifiedActionRegistry({ receiptStore: store });
    complete(registry, 'txn_tamper');
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    data.receipts[0].verification.result = 'persisted_mismatch';
    writeFileSync(filePath, JSON.stringify(data));
    assert.throws(() => store.read(), /integrity check failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('registry does not finalize a transaction when durable receipt persistence fails', () => {
  const receiptStore = {
    lastHash() { return null; },
    append() { throw new Error('disk unavailable'); },
  };
  const registry = new VerifiedActionRegistry({ receiptStore });
  const pending = registry.propose({
    id: 'txn_disk', browserId: 'browser_a', intent: 'Test storage failure', actor: { agentId: 'test' },
    target: { origin: 'https://records.example.com' }, before: { status: 'Unknown' }, changes: [{ field: 'status', to: 'Active' }],
  });
  const approved = registry.approve('txn_disk', { browserId: 'browser_a', approverId: 'worker_1', proposalHash: pending.proposalHash });
  registry.beginExecution('txn_disk', { browserId: 'browser_a', proposal: approved.proposal, currentBefore: { status: 'Unknown' } });
  assert.throws(() => registry.verify('txn_disk', { browserId: 'browser_a', after: { status: 'Active' }, persistedChanges: approved.proposal.changes }), /disk unavailable/);
  assert.equal(registry.get('txn_disk').phase, 'executing');
});
