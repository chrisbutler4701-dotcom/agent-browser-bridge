import { createHash, randomUUID } from "node:crypto";

export const VERIFIED_ACTION_SCHEMA = "work-edge.verified-action/v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`);
    return;
  }
  throw new TypeError(`${path} contains a value that cannot be represented safely in JSON`);
}

export function canonicalize(value) {
  assertJsonValue(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function freezeCopy(value) {
  return Object.freeze(structuredClone(value));
}

export function canonicalActor(actor) {
  if (!isPlainObject(actor)) throw new TypeError('actor must be an object');
  return { agentId: requireString(actor.agentId, 'actor.agentId') };
}

function proposalEvidence(proposal) {
  return {
    actorHash: sha256(canonicalActor(proposal.actor)),
    intentHash: sha256(proposal.intent),
    targetHash: sha256(proposal.target),
    changes: proposal.changes.map((change) => ({ field: change.field, valueHash: sha256(change.to) })),
  };
}

function requireSha256(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export class VerifiedActionTransaction {
  #clock;
  #state;

  constructor({ intent, actor, target, before, beforeHash, changes, clock = () => new Date(), id = randomUUID(), snapshot } = {}) {
    this.#clock = clock;
    if (snapshot !== undefined) {
      assertJsonValue(snapshot);
      const restored = structuredClone(snapshot);
      const phases = new Set(['proposed', 'approved', 'executing', 'indeterminate', 'verified', 'failed', 'rejected']);
      if (!isPlainObject(restored) || !phases.has(restored.phase) || !isPlainObject(restored.proposal)) {
        throw new Error('transaction snapshot is invalid');
      }
      requireString(restored.proposal.transactionId, 'transactionId');
      requireSha256(restored.proposal.beforeHash, 'beforeHash');
      requireSha256(restored.proposalHash, 'proposalHash');
      if (sha256(restored.proposal) !== restored.proposalHash) throw new Error('transaction proposal integrity check failed');
      if (!Array.isArray(restored.proposal.changes) || restored.proposal.changes.length === 0) throw new Error('transaction changes are invalid');
      if (['approved', 'executing', 'indeterminate', 'verified', 'failed'].includes(restored.phase)) {
        if (!isPlainObject(restored.approval) || restored.approval.proposalHash !== restored.proposalHash) {
          throw new Error('transaction approval binding is invalid');
        }
      }
      if (['verified', 'failed'].includes(restored.phase) && !verifyReceipt(restored.receipt)) {
        throw new Error('transaction receipt integrity check failed');
      }
      this.#state = restored;
      return;
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new TypeError("changes must contain at least one proposed mutation");
    }
    const fields = changes.map((change, index) => requireString(change?.field, `changes[${index}].field`));
    if (new Set(fields).size !== fields.length) throw new TypeError("changes cannot contain duplicate fields");
    if (before !== undefined && beforeHash !== undefined) throw new TypeError("provide before or beforeHash, not both");
    if (before === undefined && beforeHash === undefined) throw new TypeError("before or beforeHash is required");
    const createdAt = clock().toISOString();
    const proposal = {
      schema: VERIFIED_ACTION_SCHEMA,
      transactionId: requireString(id, "id"),
      intent: requireString(intent, "intent"),
      actor: freezeCopy(actor),
      target: freezeCopy(target),
      beforeHash: beforeHash === undefined ? sha256(before) : requireSha256(beforeHash, "beforeHash"),
      changes: freezeCopy(changes),
      createdAt,
    };
    this.#state = {
      phase: "proposed",
      proposal,
      proposalHash: sha256(proposal),
    };
  }

  static restore(snapshot, { clock = () => new Date() } = {}) {
    return new VerifiedActionTransaction({ snapshot, clock });
  }

  get snapshot() {
    return structuredClone(this.#state);
  }

  approve({ approverId, ttlMs = 5 * 60_000 }) {
    if (this.#state.phase !== "proposed") throw new Error("transaction is not awaiting approval");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
    const approvedAt = this.#clock();
    this.#state = {
      ...this.#state,
      phase: "approved",
      approval: {
        approverId: requireString(approverId, "approverId"),
        proposalHash: this.#state.proposalHash,
        approvedAt: approvedAt.toISOString(),
        expiresAt: new Date(approvedAt.getTime() + ttlMs).toISOString(),
      },
    };
    return this.snapshot;
  }

  reject({ approverId, reason = "User rejected the proposed action" }) {
    if (this.#state.phase !== "proposed") throw new Error("transaction is not awaiting approval");
    this.#state = {
      ...this.#state,
      phase: "rejected",
      rejection: {
        approverId: requireString(approverId, "approverId"),
        reason: requireString(reason, "reason").slice(0, 500),
        rejectedAt: this.#clock().toISOString(),
      },
    };
    return this.snapshot;
  }

  expire() {
    if (this.#state.phase !== 'proposed') return this.snapshot;
    this.#state = { ...this.#state, phase: 'rejected', rejection: { approverId: 'system', reason: 'Approval timed out', rejectedAt: this.#clock().toISOString() } };
    return this.snapshot;
  }

  beginExecution(proposal, currentBefore, { currentBeforeHash } = {}) {
    if (this.#state.phase !== "approved") throw new Error("transaction is not approved");
    if (this.#clock() >= new Date(this.#state.approval.expiresAt)) throw new Error("approval expired");
    const executionHash = sha256(proposal);
    if (executionHash !== this.#state.approval.proposalHash) {
      throw new Error("proposal changed after approval");
    }
    if (currentBefore !== undefined && currentBeforeHash !== undefined) {
      throw new TypeError("provide currentBefore or currentBeforeHash, not both");
    }
    if (currentBefore === undefined && currentBeforeHash === undefined) {
      throw new TypeError("currentBefore or currentBeforeHash is required");
    }
    const observedHash = currentBeforeHash === undefined
      ? sha256(currentBefore)
      : requireSha256(currentBeforeHash, "currentBeforeHash");
    if (observedHash !== this.#state.proposal.beforeHash) {
      throw new Error("pre-action state changed after approval");
    }
    this.#state = {
      ...this.#state,
      phase: "executing",
      execution: { startedAt: this.#clock().toISOString() },
    };
    return this.snapshot;
  }

  markIndeterminate({ reason = 'Execution outcome is unknown and must be reconciled' } = {}) {
    if (this.#state.phase !== 'executing') throw new Error('transaction is not executing');
    this.#state = {
      ...this.#state,
      phase: 'indeterminate',
      recovery: {
        reason: requireString(reason, 'reason').slice(0, 500),
        markedAt: this.#clock().toISOString(),
        next: 'Perform structured read-only reconciliation. Do not replay the action.',
      },
    };
    return this.snapshot;
  }

  verify({ after, persistedChanges, method = "structured-state", previousReceiptHash = null, persistReceipt }) {
    if (!['executing', 'indeterminate'].includes(this.#state.phase)) throw new Error("transaction is not executing or awaiting reconciliation");
    if (!Array.isArray(persistedChanges)) throw new TypeError("persistedChanges must be an array");
    const byField = (left, right) => String(left?.field).localeCompare(String(right?.field));
    const expected = canonicalJson([...this.#state.proposal.changes].sort(byField));
    const actual = canonicalJson([...persistedChanges].sort(byField));
    const matched = expected === actual;
    const unsignedReceipt = {
      schema: VERIFIED_ACTION_SCHEMA,
      transactionId: this.#state.proposal.transactionId,
      proposalHash: this.#state.proposalHash,
      approvedProposalEvidence: proposalEvidence(this.#state.proposal),
      approval: this.#state.approval,
      execution: {
        ...this.#state.execution,
        completedAt: this.#clock().toISOString(),
      },
      verification: {
        method: requireString(method, "method"),
        result: matched ? "persisted_match" : "persisted_mismatch",
        afterHash: sha256(after),
        persistedChangesHash: sha256(persistedChanges),
      },
      previousReceiptHash,
    };
    const receipt = { ...unsignedReceipt, receiptHash: sha256(unsignedReceipt) };
    if (persistReceipt !== undefined) {
      if (typeof persistReceipt !== "function") throw new TypeError("persistReceipt must be a function");
      persistReceipt(receipt);
    }
    this.#state = { ...this.#state, phase: matched ? "verified" : "failed", receipt };
    return this.snapshot;
  }

  failExecution({ reason, previousReceiptHash = null, persistReceipt }) {
    if (this.#state.phase !== "executing") throw new Error("transaction is not executing");
    const unsignedReceipt = {
      schema: VERIFIED_ACTION_SCHEMA,
      transactionId: this.#state.proposal.transactionId,
      proposalHash: this.#state.proposalHash,
      approvedProposalEvidence: proposalEvidence(this.#state.proposal),
      approval: this.#state.approval,
      execution: {
        ...this.#state.execution,
        completedAt: this.#clock().toISOString(),
      },
      verification: {
        method: "execution-result",
        result: "execution_failed",
        reason: requireString(reason, "reason").slice(0, 500),
      },
      previousReceiptHash,
    };
    const receipt = { ...unsignedReceipt, receiptHash: sha256(unsignedReceipt) };
    if (persistReceipt !== undefined) {
      if (typeof persistReceipt !== "function") throw new TypeError("persistReceipt must be a function");
      persistReceipt(receipt);
    }
    this.#state = { ...this.#state, phase: "failed", receipt };
    return this.snapshot;
  }
}

export function verifyReceipt(receipt) {
  if (!isPlainObject(receipt) || typeof receipt.receiptHash !== "string") return false;
  const { receiptHash, ...unsignedReceipt } = receipt;
  return sha256(unsignedReceipt) === receiptHash;
}
