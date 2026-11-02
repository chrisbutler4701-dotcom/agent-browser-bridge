import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyReceipt } from './verified-action.js';

const DEFAULT_RECEIPT_FILE = process.env.WORK_EDGE_RECEIPT_STORE || '/etc/work-edge/verified-action-receipts.json';

function validData(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.receipts)) throw new Error('Receipt store is invalid.');
  return value;
}

export class ReceiptStore {
  constructor({ filePath = DEFAULT_RECEIPT_FILE } = {}) {
    this.filePath = filePath;
  }

  read() {
    if (!this.filePath || !existsSync(this.filePath)) return { version: 1, receipts: [] };
    let data;
    try { data = validData(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) { throw new Error(`Receipt store is unreadable: ${error.message}`); }
    this.verifyChain(data.receipts);
    return data;
  }

  lastHash() {
    const receipts = this.read().receipts;
    return receipts.at(-1)?.receiptHash || null;
  }

  get(transactionId) {
    if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('transactionId is required');
    return this.read().receipts.find((receipt) => receipt.transactionId === transactionId) || null;
  }

  append(receipt) {
    if (!verifyReceipt(receipt)) throw new Error('Receipt integrity check failed.');
    const data = this.read();
    const expectedPrevious = data.receipts.at(-1)?.receiptHash || null;
    if (receipt.previousReceiptHash !== expectedPrevious) throw new Error('Receipt chain link does not match the durable head.');
    if (data.receipts.some((item) => item.transactionId === receipt.transactionId)) throw new Error('A receipt already exists for this transaction.');
    data.receipts.push(structuredClone(receipt));
    this.#write(data);
    return receipt;
  }

  verifyChain(receipts = this.read().receipts) {
    let previous = null;
    for (const receipt of receipts) {
      if (!verifyReceipt(receipt)) throw new Error('Receipt integrity check failed.');
      if (receipt.previousReceiptHash !== previous) throw new Error('Receipt chain is broken.');
      previous = receipt.receiptHash;
    }
    return { valid: true, count: receipts.length, head: previous };
  }

  #write(data) {
    if (!this.filePath) throw new Error('Receipt store path is not configured.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
