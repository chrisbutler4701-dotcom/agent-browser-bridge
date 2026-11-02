import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function validRecord(record) {
  if (!record || typeof record !== 'object' || !/^[A-Za-z0-9_-]+$/.test(record.credentialId || '')) throw new Error('Passkey store contains an invalid credential id.');
  if (record.publicKeyJwk?.kty !== 'EC' || record.publicKeyJwk?.crv !== 'P-256' || typeof record.publicKeyJwk.x !== 'string' || typeof record.publicKeyJwk.y !== 'string') throw new Error('Passkey store contains an invalid public key.');
  if (!Number.isSafeInteger(record.signCount) || record.signCount < 0) throw new Error('Passkey store contains an invalid signature counter.');
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Passkey store contains an invalid creation time.');
  if (typeof record.label !== 'string' || !record.label || record.label.length > 80) throw new Error('Passkey store contains an invalid label.');
  return record;
}

export class PasskeyStore {
  constructor({ filePath, clock = () => new Date() } = {}) { this.filePath = filePath; this.clock = clock; }

  list() { return this.#read().passkeys.map((record) => structuredClone(record)); }

  get(credentialId) { return this.list().find((record) => record.credentialId === credentialId) || null; }

  add({ credentialId, publicKeyJwk, signCount, label }) {
    const data = this.#read();
    if (data.passkeys.some((record) => record.credentialId === credentialId)) throw new Error('Passkey is already registered.');
    const cleanLabel = String(label || 'Passkey').trim();
    if (!cleanLabel || cleanLabel.length > 80 || /[\x00-\x1f<>]/.test(cleanLabel)) throw new Error('Passkey label must be 1-80 plain characters.');
    const record = validRecord({ credentialId, publicKeyJwk, signCount, createdAt: this.clock().toISOString(), label: cleanLabel });
    data.passkeys.push(record);
    this.#write(data);
    return structuredClone(record);
  }

  remove(credentialId) {
    const data = this.#read();
    const index = data.passkeys.findIndex((record) => record.credentialId === credentialId);
    if (index < 0) return false;
    data.passkeys.splice(index, 1);
    this.#write(data);
    return true;
  }

  updateSignCount(credentialId, signCount) {
    const data = this.#read();
    const record = data.passkeys.find((candidate) => candidate.credentialId === credentialId);
    if (!record) throw new Error('Passkey was not found.');
    if (!Number.isSafeInteger(signCount) || signCount < 0) throw new Error('Passkey signature counter is invalid.');
    record.signCount = signCount;
    this.#write(data);
    return structuredClone(record);
  }

  #read() {
    if (!this.filePath || !existsSync(this.filePath)) return { version: 1, passkeys: [] };
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.passkeys)) throw new Error('invalid shape');
      data.passkeys.forEach(validRecord);
      if (new Set(data.passkeys.map((record) => record.credentialId)).size !== data.passkeys.length) throw new Error('duplicate credential ids');
      return data;
    } catch (error) { throw new Error(`Passkey store is unreadable: ${error.message}`); }
  }

  #write(data) {
    if (!this.filePath) throw new Error('Passkey store path is not configured.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
