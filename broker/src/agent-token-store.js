import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeCapabilities } from './agent-capabilities.js';

const DEFAULT_AGENT_TOKEN_FILE = process.env.WORK_EDGE_AGENT_TOKEN_STORE || '/etc/work-edge/agent-tokens.json';

function tokenHash(token) {
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('agent token must contain at least 32 characters');
  return createHash('sha256').update(token).digest('hex');
}

function principalId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value) || value.startsWith('fbg:')) {
    throw new TypeError('agent id must use 1-100 letters, numbers, dots, underscores, colons, or hyphens');
  }
  return value;
}

function validData(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.principals)) throw new Error('Agent token store is invalid.');
  const ids = new Set();
  const hashes = new Set();
  for (const principal of value.principals) {
    principalId(principal?.id);
    if (ids.has(principal.id)) throw new Error('Agent token store contains duplicate ids.');
    if (typeof principal.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(principal.tokenHash) || hashes.has(principal.tokenHash)) throw new Error('Agent token store contains invalid token hashes.');
    normalizeCapabilities(principal.capabilities);
    if (typeof principal.createdAt !== 'string' || !Number.isFinite(Date.parse(principal.createdAt))) throw new Error('Agent token store contains an invalid creation time.');
    if (principal.revokedAt !== undefined && (typeof principal.revokedAt !== 'string' || !Number.isFinite(Date.parse(principal.revokedAt)))) throw new Error('Agent token store contains an invalid revocation time.');
    if (principal.reprovisionedAt !== undefined && (typeof principal.reprovisionedAt !== 'string' || !Number.isFinite(Date.parse(principal.reprovisionedAt)))) throw new Error('Agent token store contains an invalid reprovision time.');
    if (principal.credentialVersion !== undefined && (!Number.isSafeInteger(principal.credentialVersion) || principal.credentialVersion < 1)) throw new Error('Agent token store contains an invalid credential version.');
    ids.add(principal.id);
    hashes.add(principal.tokenHash);
  }
  return value;
}

export class AgentTokenStore {
  constructor({ filePath = DEFAULT_AGENT_TOKEN_FILE, clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
  }

  activeCount() {
    return this.#read().principals.filter((principal) => !principal.revokedAt).length;
  }

  hasProvisionedIdentity() {
    return this.#read().principals.length > 0;
  }

  list() {
    return this.#read().principals.map(({ tokenHash: omitted, ...principal }) => structuredClone(principal));
  }

  create({ id, capabilities }) {
    const token = randomBytes(32).toString('base64url');
    this.add(token, { id, capabilities });
    return { id, token, capabilities: normalizeCapabilities(capabilities) };
  }

  add(token, { id, capabilities }) {
    const data = this.#read();
    const normalizedId = principalId(id);
    const digest = tokenHash(token);
    const existing = data.principals.find((principal) => principal.id === normalizedId);
    if (existing && !existing.revokedAt) throw new Error('agent id already exists');
    if (data.principals.some((principal) => principal.tokenHash === digest)) throw new Error('agent token already exists');
    const now = this.clock().toISOString();
    if (existing) {
      existing.tokenHash = digest;
      existing.capabilities = normalizeCapabilities(capabilities);
      existing.credentialVersion = (existing.credentialVersion || 1) + 1;
      existing.reprovisionedAt = now;
      delete existing.revokedAt;
    } else {
      data.principals.push({
        id: normalizedId,
        tokenHash: digest,
        capabilities: normalizeCapabilities(capabilities),
        credentialVersion: 1,
        createdAt: now,
      });
    }
    this.#write(data);
    return { id: normalizedId, capabilities: normalizeCapabilities(capabilities) };
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const supplied = Buffer.from(tokenHash(token), 'hex');
    const principal = this.#read().principals.find((candidate) => {
      const expected = Buffer.from(candidate.tokenHash, 'hex');
      return !candidate.revokedAt && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    return principal ? { id: principal.id, capabilities: [...principal.capabilities], source: 'agent-token-store' } : null;
  }

  revoke(id) {
    const data = this.#read();
    const principal = data.principals.find((candidate) => candidate.id === principalId(id));
    if (!principal || principal.revokedAt) return false;
    principal.revokedAt = this.clock().toISOString();
    this.#write(data);
    return true;
  }

  #read() {
    if (!this.filePath || !existsSync(this.filePath)) return { version: 1, principals: [] };
    try { return validData(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) { throw new Error(`Agent token store is unreadable: ${error.message}`); }
  }

  #write(data) {
    if (!this.filePath) throw new Error('Agent token store path is not configured.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
