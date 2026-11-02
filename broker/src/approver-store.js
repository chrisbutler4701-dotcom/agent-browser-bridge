import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_APPROVER_FILE = process.env.FBB_APPROVER_STORE || '/data/approvers.json';

function keyHash(key) {
  if (typeof key !== 'string' || key.length < 32) throw new TypeError('approver key must contain at least 32 characters');
  return createHash('sha256').update(key).digest('hex');
}

function approverId(value) {
  if (typeof value !== 'string' || !/^apr_[a-f0-9]{16}$/.test(value)) throw new TypeError('approver id is invalid');
  return value;
}

function approverLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 80 || /[\r\n<>]/.test(label)) throw new TypeError('approver label must be 1-80 plain characters');
  return label;
}

function validData(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.approvers)) throw new Error('Approver store is invalid.');
  const ids = new Set();
  const hashes = new Set();
  for (const approver of value.approvers) {
    approverId(approver?.id);
    approverLabel(approver?.label);
    if (ids.has(approver.id)) throw new Error('Approver store contains duplicate ids.');
    if (typeof approver.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(approver.keyHash) || hashes.has(approver.keyHash)) throw new Error('Approver store contains invalid key hashes.');
    if (typeof approver.createdAt !== 'string' || !Number.isFinite(Date.parse(approver.createdAt))) throw new Error('Approver store contains an invalid creation time.');
    if (approver.revokedAt !== undefined && (typeof approver.revokedAt !== 'string' || !Number.isFinite(Date.parse(approver.revokedAt)))) throw new Error('Approver store contains an invalid revocation time.');
    ids.add(approver.id);
    hashes.add(approver.keyHash);
  }
  return value;
}

export class ApproverStore {
  constructor({ filePath = DEFAULT_APPROVER_FILE, clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
  }

  create({ label }) {
    const data = this.#read();
    const key = randomBytes(32).toString('base64url');
    let id;
    do id = `apr_${randomBytes(8).toString('hex')}`; while (data.approvers.some((approver) => approver.id === id));
    const stored = { id, keyHash: keyHash(key), label: approverLabel(label), createdAt: this.clock().toISOString() };
    data.approvers.push(stored);
    this.#write(data);
    return { id, key, label: stored.label, createdAt: stored.createdAt };
  }

  authenticate(key) {
    if (typeof key !== 'string' || key.length < 32) return null;
    const supplied = Buffer.from(keyHash(key), 'hex');
    const approver = this.#read().approvers.find((candidate) => {
      const expected = Buffer.from(candidate.keyHash, 'hex');
      return !candidate.revokedAt && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    return approver ? { id: approver.id, label: approver.label } : null;
  }

  list() {
    return this.#read().approvers.map(({ keyHash: omitted, ...approver }) => structuredClone(approver));
  }

  revoke(id) {
    const data = this.#read();
    const approver = data.approvers.find((candidate) => candidate.id === approverId(id));
    if (!approver || approver.revokedAt) return false;
    approver.revokedAt = this.clock().toISOString();
    this.#write(data);
    return true;
  }

  #read() {
    if (!this.filePath || !existsSync(this.filePath)) return { version: 1, approvers: [] };
    try { return validData(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) { throw new Error(`Approver store is unreadable: ${error.message}`); }
  }

  #write(data) {
    if (!this.filePath) throw new Error('Approver store path is not configured.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
