import { VerifiedActionTransaction, VERIFIED_ACTION_SCHEMA, sha256 } from "./verified-action.js";

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export class VerifiedActionRegistry {
  #clock;
  #limit;
  #receiptStore;
  #transactionStore;
  #proposalTtlMs;
  #transactions = new Map();

  constructor({ clock = () => new Date(), limit = 1000, receiptStore = null, transactionStore = null, proposalTtlMs = 10 * 60_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    this.#clock = clock;
    this.#limit = limit;
    this.#receiptStore = receiptStore;
    this.#transactionStore = transactionStore;
    if (!Number.isSafeInteger(proposalTtlMs) || proposalTtlMs < 1) throw new TypeError("proposalTtlMs must be a positive integer");
    this.#proposalTtlMs = proposalTtlMs;
    this.#restore();
  }

  propose({ browserId, intent, actor, target, before, beforeHash, changes, id }) {
    const boundBrowserId = requireString(browserId, "browserId");
    if (this.#transactions.size >= this.#limit) this.#pruneOne();
    if (this.#transactions.size >= this.#limit) throw new Error("verified action registry is full");
    const transaction = new VerifiedActionTransaction({
      intent,
      actor,
      target: { ...target, browserId: boundBrowserId },
      before,
      beforeHash,
      changes,
      clock: this.#clock,
      id,
    });
    const snapshot = transaction.snapshot;
    if (this.#transactions.has(snapshot.proposal.transactionId)) throw new Error("transaction id already exists");
    this.#transactionStore?.put(snapshot);
    this.#transactions.set(snapshot.proposal.transactionId, transaction);
    return snapshot;
  }

  get(id) {
    const transaction = this.#transactions.get(requireString(id, "transactionId"));
    return transaction?.snapshot || null;
  }

  pendingForBrowser(browserId) {
    const boundBrowserId = requireString(browserId, "browserId");
    return [...this.#transactions.values()]
      .map((transaction) => transaction.snapshot)
      .filter((snapshot) => snapshot.phase === "proposed" && snapshot.proposal.target.browserId === boundBrowserId && this.#proposalIsFresh(snapshot))
      .sort((left, right) => left.proposal.createdAt.localeCompare(right.proposal.createdAt));
  }

  approve(id, { browserId, approverId, proposalHash, ttlMs }) {
    const transaction = this.#required(id);
    const snapshot = transaction.snapshot;
    this.#assertBrowser(snapshot, browserId);
    if (!this.#proposalIsFresh(snapshot)) throw new Error("proposal expired");
    if (requireString(proposalHash, "proposalHash") !== snapshot.proposalHash) throw new Error("proposal hash does not match");
    return this.#transition(transaction, () => transaction.approve({ approverId, ttlMs }));
  }

  reject(id, { browserId, approverId, proposalHash, reason }) {
    const transaction = this.#required(id);
    const snapshot = transaction.snapshot;
    this.#assertBrowser(snapshot, browserId);
    if (!this.#proposalIsFresh(snapshot)) throw new Error("proposal expired");
    if (requireString(proposalHash, "proposalHash") !== snapshot.proposalHash) throw new Error("proposal hash does not match");
    const decided = this.#transition(transaction, () => transaction.reject({ approverId, reason }));
    this.#singleClickReceipt(decided, 'declined');
    return decided;
  }

  expire(id) {
    const transaction = this.#required(id);
    const expired = this.#transition(transaction, () => transaction.expire());
    this.#singleClickReceipt(expired, 'expired');
    return expired;
  }

  #singleClickReceipt(snapshot, status) {
    if (snapshot.proposal?.target?.kind !== 'single_click' || !this.#receiptStore) return;
    if (this.#receiptStore.get(snapshot.proposal.transactionId)) return;
    const unsigned = { schema: VERIFIED_ACTION_SCHEMA, kind: 'single_click', transactionId: snapshot.proposal.transactionId,
      proposalHash: snapshot.proposalHash, approval: null, status, completedAt: this.#clock().toISOString(),
      previousReceiptHash: this.#receiptStore.lastHash() };
    this.#receiptStore.append({ ...unsigned, receiptHash: sha256(unsigned) });
  }

  beginExecution(id, { browserId, proposal, currentBefore, currentBeforeHash }) {
    const transaction = this.#required(id);
    this.#assertBrowser(transaction.snapshot, browserId);
    return this.#transition(transaction, () => transaction.beginExecution(proposal, currentBefore, { currentBeforeHash }));
  }

  markIndeterminate(id, { browserId, reason }) {
    const transaction = this.#required(id);
    this.#assertBrowser(transaction.snapshot, browserId);
    return this.#transition(transaction, () => transaction.markIndeterminate({ reason }));
  }

  verify(id, { browserId, after, persistedChanges, method, previousReceiptHash }) {
    const transaction = this.#required(id);
    this.#assertBrowser(transaction.snapshot, browserId);
    const chainHead = this.#receiptStore ? this.#receiptStore.lastHash() : previousReceiptHash;
    return this.#transition(transaction, () => transaction.verify({
      after, persistedChanges, method, previousReceiptHash: chainHead,
      persistReceipt: this.#receiptStore ? (receipt) => this.#receiptStore.append(receipt) : undefined,
    }));
  }

  failExecution(id, { browserId, reason, previousReceiptHash }) {
    const transaction = this.#required(id);
    this.#assertBrowser(transaction.snapshot, browserId);
    const chainHead = this.#receiptStore ? this.#receiptStore.lastHash() : previousReceiptHash;
    return this.#transition(transaction, () => transaction.failExecution({
      reason, previousReceiptHash: chainHead,
      persistReceipt: this.#receiptStore ? (receipt) => this.#receiptStore.append(receipt) : undefined,
    }));
  }

  #restore() {
    if (!this.#transactionStore) return;
    for (const stored of this.#transactionStore.list()) {
      const id = stored?.proposal?.transactionId;
      if (typeof id !== 'string' || !id) throw new Error('durable transaction is missing its id');
      let snapshot = stored;
      const receipt = this.#receiptStore?.get(id);
      if (receipt && receipt.kind === 'single_click' && ['declined', 'expired'].includes(receipt.status)) {
        snapshot = { ...stored, phase: 'rejected', rejection: stored.rejection || { approverId: 'system', reason: receipt.status, rejectedAt: receipt.completedAt } };
      } else if (receipt) {
        snapshot = {
          ...stored,
          phase: receipt.verification?.result === 'persisted_match' ? 'verified' : 'failed',
          approval: receipt.approval,
          execution: receipt.execution,
          receipt,
        };
      }
      let transaction = VerifiedActionTransaction.restore(snapshot, { clock: this.#clock });
      if (snapshot.phase === 'proposed' && snapshot.proposal.target?.kind === 'single_click'
        && Date.parse(snapshot.proposal.target.expiresAt) <= this.#clock().getTime()) {
        snapshot = transaction.expire();
        this.#transactionStore.put(snapshot);
        this.#singleClickReceipt(snapshot, 'expired');
      } else if (snapshot.phase === 'rejected' && snapshot.proposal.target?.kind === 'single_click') {
        this.#singleClickReceipt(snapshot, snapshot.rejection?.approverId === 'system' ? 'expired' : 'declined');
      }
      if (!receipt && snapshot.phase === 'executing') {
        transaction.markIndeterminate({ reason: 'Broker restarted before the execution outcome was durably resolved.' });
        this.#transactionStore.put(transaction.snapshot);
      }
      if (this.#transactions.has(id)) throw new Error('durable transaction id is duplicated');
      this.#transactions.set(id, transaction);
    }
  }

  #transition(transaction, change) {
    const before = transaction.snapshot;
    let after;
    try {
      after = change();
      this.#transactionStore?.put(after);
      return after;
    } catch (error) {
      const id = before.proposal.transactionId;
      let receipt = null;
      try { receipt = this.#receiptStore?.get(id) || null; } catch {}
      if (receipt) {
        const recovered = {
          ...(after || before),
          phase: receipt.verification?.result === 'persisted_match' ? 'verified' : 'failed',
          approval: receipt.approval,
          execution: receipt.execution,
          receipt,
        };
        this.#transactions.set(id, VerifiedActionTransaction.restore(recovered, { clock: this.#clock }));
        return structuredClone(recovered);
      }
      this.#transactions.set(id, VerifiedActionTransaction.restore(before, { clock: this.#clock }));
      throw error;
    }
  }

  #required(id) {
    const transaction = this.#transactions.get(requireString(id, "transactionId"));
    if (!transaction) throw new Error("transaction not found");
    return transaction;
  }

  #assertBrowser(snapshot, browserId) {
    if (snapshot.proposal.target.browserId !== requireString(browserId, "browserId")) {
      throw new Error("transaction is bound to a different browser");
    }
  }

  #proposalIsFresh(snapshot) {
    return this.#clock().getTime() - new Date(snapshot.proposal.createdAt).getTime() < this.#proposalTtlMs
      && (!snapshot.proposal.target?.expiresAt || this.#clock().getTime() < Date.parse(snapshot.proposal.target.expiresAt));
  }

  #pruneOne() {
    for (const [id, transaction] of this.#transactions) {
      if (["verified", "failed", "rejected"].includes(transaction.snapshot.phase)) {
        this.#transactionStore?.remove(id);
        this.#transactions.delete(id);
        return;
      }
    }
  }
}
