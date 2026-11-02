import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './verified-action.js';

const DEFAULT_TRANSACTION_FILE = process.env.WORK_EDGE_TRANSACTION_STORE || '/etc/work-edge/verified-action-transactions.json';
const DEFAULT_KEY_FILE = process.env.WORK_EDGE_TRANSACTION_KEY || '/etc/work-edge/verified-action-transactions.key';
const CIPHER = 'aes-256-gcm';

function validData(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.transactions)) {
    throw new Error('Transaction store is invalid.');
  }
  return value;
}

function requireDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function decode(value, bytes, name) {
  if (typeof value !== 'string') throw new Error(`${name} is invalid.`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) throw new Error(`${name} is invalid.`);
  return decoded;
}

function aad(record) {
  return Buffer.from(canonicalJson({
    version: 1,
    transactionId: record.transactionId,
    proposalHash: record.proposalHash,
  }));
}

export class TransactionStore {
  constructor({ filePath = DEFAULT_TRANSACTION_FILE, keyFile = DEFAULT_KEY_FILE, key } = {}) {
    if (key !== undefined && (!Buffer.isBuffer(key) || key.length !== 32)) throw new TypeError('key must be a 32-byte Buffer');
    this.filePath = filePath;
    this.keyFile = keyFile;
    this.key = key ? Buffer.from(key) : null;
  }

  list() {
    const data = this.#readData();
    if (data.transactions.length === 0) return [];
    const key = this.#loadKey(false);
    return data.transactions.map((record) => this.#open(record, key));
  }

  put(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.proposal) throw new TypeError('transaction snapshot is required');
    const transactionId = snapshot.proposal.transactionId;
    const proposalHash = requireDigest(snapshot.proposalHash, 'proposalHash');
    if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('transactionId is required');
    const data = this.#readData();
    const record = this.#seal(structuredClone(snapshot), { transactionId, proposalHash }, this.#loadKey(data.transactions.length === 0));
    const index = data.transactions.findIndex((item) => item.transactionId === transactionId);
    if (index === -1) data.transactions.push(record);
    else data.transactions[index] = record;
    this.#writeData(data);
    return structuredClone(snapshot);
  }

  remove(transactionId) {
    if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('transactionId is required');
    const data = this.#readData();
    const filtered = data.transactions.filter((record) => record.transactionId !== transactionId);
    if (filtered.length === data.transactions.length) return false;
    data.transactions = filtered;
    this.#writeData(data);
    return true;
  }

  #readData() {
    if (!this.filePath || !existsSync(this.filePath)) return { version: 1, transactions: [] };
    try { return validData(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) { throw new Error(`Transaction store is unreadable: ${error.message}`); }
  }

  #loadKey(create) {
    if (this.key) return this.key;
    if (this.keyFile && existsSync(this.keyFile)) {
      let key;
      try { key = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'hex'); }
      catch (error) { throw new Error(`Transaction key is unreadable: ${error.message}`); }
      if (key.length !== 32) throw new Error('Transaction key is invalid.');
      this.key = key;
      return key;
    }
    if (!create) throw new Error('Transaction key is missing.');
    if (!this.keyFile) throw new Error('Transaction key path is not configured.');
    const key = randomBytes(32);
    mkdirSync(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.keyFile, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(this.keyFile, 0o600);
    this.key = key;
    return key;
  }

  #seal(snapshot, metadata, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CIPHER, key, iv);
    const record = { ...metadata };
    cipher.setAAD(aad(record));
    const ciphertext = Buffer.concat([cipher.update(canonicalJson(snapshot), 'utf8'), cipher.final()]);
    return {
      ...record,
      sealed: {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    };
  }

  #open(record, key) {
    try {
      if (!record || typeof record !== 'object' || !record.sealed) throw new Error('record is invalid');
      if (typeof record.transactionId !== 'string' || !record.transactionId) throw new Error('transactionId is invalid');
      requireDigest(record.proposalHash, 'proposalHash');
      const decipher = createDecipheriv(CIPHER, key, decode(record.sealed.iv, 12, 'iv'));
      decipher.setAAD(aad(record));
      decipher.setAuthTag(decode(record.sealed.tag, 16, 'authentication tag'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const snapshot = JSON.parse(plaintext);
      if (snapshot?.proposal?.transactionId !== record.transactionId || snapshot?.proposalHash !== record.proposalHash) {
        throw new Error('record metadata does not match its sealed snapshot');
      }
      return snapshot;
    } catch (error) {
      throw new Error(`Transaction store integrity check failed: ${error.message}`);
    }
  }

  #writeData(data) {
    if (!this.filePath) throw new Error('Transaction store path is not configured.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
