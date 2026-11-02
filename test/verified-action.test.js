import assert from "node:assert/strict";
import test from "node:test";
import { VerifiedActionTransaction, canonicalActor, canonicalJson, sha256, verifyReceipt } from "../broker/src/verified-action.js";

function tickingClock(start = "2026-09-12T12:00:00.000Z") {
  let now = new Date(start);
  const clock = () => new Date(now);
  clock.advance = (ms) => { now = new Date(now.getTime() + ms); };
  return clock;
}

function transaction(clock = tickingClock()) {
  return new VerifiedActionTransaction({
    id: "txn_demo",
    intent: "Update synthetic housing assessment",
    actor: { userId: "worker_1", agentId: "hermes" },
    target: { origin: "https://records.example.com", recordIdHash: "record_hash" },
    before: { housingStatus: "Unknown" },
    changes: [{ field: "housingStatus", from: "Unknown", to: "Currently housed" }],
    clock,
  });
}

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("canonical JSON rejects ambiguous non-JSON values", () => {
  assert.throws(() => canonicalJson({ value: undefined }), /cannot be represented safely/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
});

test('canonical actor isolates the authenticated ownership identity', () => {
  assert.deepEqual(canonicalActor({ userId: 'worker_1', agentId: 'hermes', machineId: 'edge-1' }), { agentId: 'hermes' });
  assert.equal(
    sha256(canonicalActor({ agentId: 'hermes', userId: 'worker_1' })),
    sha256(canonicalActor({ agentId: 'hermes', approverId: 'supervisor_1' })),
  );
  assert.throws(() => canonicalActor({ userId: 'worker_1' }), /actor\.agentId/);
});

test("a proposal cannot change the same field twice", () => {
  assert.throws(() => new VerifiedActionTransaction({
    intent: "Ambiguous update",
    actor: { userId: "worker_1" },
    target: { origin: "https://records.example.com" },
    before: {},
    changes: [{ field: "status", to: "A" }, { field: "status", to: "B" }],
  }), /duplicate fields/);
});

test("approval binds execution to the exact proposal", () => {
  const tx = transaction();
  const approved = tx.approve({ approverId: "worker_1" });
  const changed = structuredClone(approved.proposal);
  changed.changes[0].to = "Unsheltered";
  assert.throws(() => tx.beginExecution(changed, { housingStatus: "Unknown" }), /changed after approval/);
});

test("expired approval cannot execute", () => {
  const clock = tickingClock();
  const tx = transaction(clock);
  const approved = tx.approve({ approverId: "worker_1", ttlMs: 1000 });
  clock.advance(1000);
  assert.throws(() => tx.beginExecution(approved.proposal, { housingStatus: "Unknown" }), /expired/);
});

test("state drift after approval blocks execution", () => {
  const tx = transaction();
  const approved = tx.approve({ approverId: "worker_1" });
  assert.throws(
    () => tx.beginExecution(approved.proposal, { housingStatus: "Transitional housing" }),
    /pre-action state changed after approval/,
  );
});

test("browser adapters can keep field values local and supply state hashes", () => {
  const beforeHash = sha256({ housingStatus: "Unknown" });
  const tx = new VerifiedActionTransaction({
    id: "txn_private",
    intent: "Update a field without exporting its current value",
    actor: { userId: "worker_1", agentId: "hermes" },
    target: { origin: "https://records.example.com", recordIdHash: "record_hash" },
    beforeHash,
    changes: [{ field: "housingStatus", to: "Currently housed" }],
  });
  const approved = tx.approve({ approverId: "worker_1" });
  const executing = tx.beginExecution(approved.proposal, undefined, { currentBeforeHash: beforeHash });
  assert.equal(executing.phase, "executing");
});

test("matching persisted state creates a valid receipt", () => {
  const tx = transaction();
  const approved = tx.approve({ approverId: "worker_1" });
  tx.beginExecution(approved.proposal, { housingStatus: "Unknown" });
  const final = tx.verify({
    after: { housingStatus: "Currently housed" },
    persistedChanges: approved.proposal.changes,
  });
  assert.equal(final.phase, "verified");
  assert.equal(final.receipt.verification.result, "persisted_match");
  assert.deepEqual(final.receipt.approvedProposalEvidence.changes, [
    { field: "housingStatus", valueHash: sha256("Currently housed") },
  ]);
  assert.equal(final.receipt.approvedProposalEvidence.actorHash, sha256({ agentId: 'hermes' }));
  assert.equal(JSON.stringify(final.receipt).includes("Currently housed"), false);
  assert.equal(verifyReceipt(final.receipt), true);
});

test("mismatched persisted state fails closed but remains receipted", () => {
  const tx = transaction();
  const approved = tx.approve({ approverId: "worker_1" });
  tx.beginExecution(approved.proposal, { housingStatus: "Unknown" });
  const final = tx.verify({
    after: { housingStatus: "Unknown" },
    persistedChanges: [{ field: "housingStatus", from: "Unknown", to: "Unknown" }],
  });
  assert.equal(final.phase, "failed");
  assert.equal(final.receipt.verification.result, "persisted_mismatch");
  assert.equal(verifyReceipt(final.receipt), true);
});

test("receipt tampering is detected", () => {
  const tx = transaction();
  const approved = tx.approve({ approverId: "worker_1" });
  tx.beginExecution(approved.proposal, { housingStatus: "Unknown" });
  const final = tx.verify({ after: { housingStatus: "Currently housed" }, persistedChanges: approved.proposal.changes });
  const tampered = structuredClone(final.receipt);
  tampered.verification.result = "persisted_mismatch";
  assert.equal(verifyReceipt(tampered), false);
});

test("verification ignores adapter field order", () => {
  const tx = new VerifiedActionTransaction({
    id: "txn_order",
    intent: "Update two synthetic fields",
    actor: { userId: "worker_1", agentId: "hermes" },
    target: { origin: "https://records.example.com", recordIdHash: "record_hash" },
    before: { housingStatus: "Unknown", benefitsStatus: "Unknown" },
    changes: [
      { field: "housingStatus", from: "Unknown", to: "Currently housed" },
      { field: "benefitsStatus", from: "Unknown", to: "Active" },
    ],
  });
  const approved = tx.approve({ approverId: "worker_1" });
  tx.beginExecution(approved.proposal, { housingStatus: "Unknown", benefitsStatus: "Unknown" });
  const final = tx.verify({
    after: { housingStatus: "Currently housed", benefitsStatus: "Active" },
    persistedChanges: [...approved.proposal.changes].reverse(),
  });
  assert.equal(final.phase, "verified");
});
