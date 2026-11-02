import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeCapabilities } from './agent-capabilities.js';

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 100;
const REGISTRATION_WINDOW_MS = 60 * 60_000;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const pkceChallenge = (value) => createHash('sha256').update(String(value)).digest('base64url');
const token = () => randomBytes(32).toString('base64url');
const equal = (left, right) => {
  const a = Buffer.from(digest(left), 'hex');
  const b = Buffer.from(digest(right), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const equalDigest = (value, expectedDigest) => {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  const actual = Buffer.from(digest(value), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return timingSafeEqual(actual, expected);
};
const equalEncoded = (left, right) => {
  const actual = Buffer.from(String(left));
  const expected = Buffer.from(String(right));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const findDigestRecord = (records, rawValue) => {
  const supplied = Buffer.from(digest(rawValue), 'hex');
  for (const [storedDigest, record] of Object.entries(records)) {
    const expected = Buffer.from(storedDigest, 'hex');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return [storedDigest, record];
  }
  return [null, null];
};

function validRedirect(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost');
  } catch { return false; }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function emptyState() {
  return { version: 1, clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} };
}

function validateState(value) {
  if (!value || value.version !== 1 || typeof value.clients !== 'object' || typeof value.codes !== 'object'
    || typeof value.accessTokens !== 'object' || typeof value.refreshTokens !== 'object') throw new Error('OAuth state is invalid.');
  return value;
}

export function parseOAuthCapabilities(value) {
  if (typeof value !== 'string' || !value.trim()) return ['browser.read'];
  const capabilities = normalizeCapabilities(value.split(',').map((item) => item.trim()).filter(Boolean));
  if (capabilities.includes('private_browser_local')) throw new TypeError('OAuth defaults cannot include private_browser_local.');
  return capabilities;
}

export class OAuthProvider {
  constructor({ publicBaseUrl, passphrase, stateFile, capabilities, maxClients = 50, registrationsPerIpPerHour = 10, now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (typeof publicBaseUrl !== 'string' || !publicBaseUrl.trim()) throw new Error('publicBaseUrl is required');
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
    this.passphrase = typeof passphrase === 'string' ? passphrase : '';
    this.stateFile = stateFile || '/var/lib/field-browser-bridge/oauth.json';
    this.capabilities = parseOAuthCapabilities(capabilities);
    this.maxClients = maxClients;
    this.registrationsPerIpPerHour = registrationsPerIpPerHour;
    this.now = now;
    this.delay = delay;
    this.pending = new Map();
    this.failures = new Map();
    this.globalFailures = [];
    this.registrations = new Map();
  }

  metadata(pathname) {
    if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') {
      return { resource: `${this.publicBaseUrl}/mcp`, authorization_servers: [this.publicBaseUrl] };
    }
    if (pathname === '/.well-known/oauth-authorization-server') {
      return {
        issuer: this.publicBaseUrl,
        authorization_endpoint: `${this.publicBaseUrl}/authorize`,
        token_endpoint: `${this.publicBaseUrl}/token`,
        registration_endpoint: `${this.publicBaseUrl}/register`,
        revocation_endpoint: `${this.publicBaseUrl}/revoke`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      };
    }
    return null;
  }

  register(input, { ip } = {}) {
    if (!Array.isArray(input?.redirect_uris) || input.redirect_uris.length === 0 || !input.redirect_uris.every(validRedirect)) throw new Error('redirect_uris must contain only HTTPS or loopback HTTP URLs');
    const method = input.token_endpoint_auth_method || 'client_secret_post';
    if (!['client_secret_post', 'client_secret_basic', 'none'].includes(method)) throw new Error('unsupported token_endpoint_auth_method');
    const grants = input.grant_types || ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || grants.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))) throw new Error('unsupported grant_types');
    const state = this.#read();
    if (Object.keys(state.clients).length >= this.maxClients) throw new Error('client limit reached');
    this.#pruneRegistrations();
    const registrationIp = String(ip || 'unknown');
    const registrations = this.registrations.get(registrationIp) || [];
    if (registrations.length >= this.registrationsPerIpPerHour) {
      const error = new Error('registration rate limit reached');
      error.status = 429;
      throw error;
    }
    const clientId = token();
    const clientSecret = method === 'none' ? null : token();
    state.clients[clientId] = {
      clientId,
      clientSecretDigest: clientSecret ? digest(clientSecret) : null,
      clientName: typeof input.client_name === 'string' && input.client_name.trim() ? input.client_name.trim().slice(0, 200) : 'MCP client',
      redirectUris: [...new Set(input.redirect_uris)],
      tokenEndpointAuthMethod: method,
      grantTypes: [...new Set(grants)],
      capabilities: [...this.capabilities],
    };
    this.#write(state);
    registrations.push(this.now());
    this.registrations.set(registrationIp, registrations);
    return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), client_name: state.clients[clientId].clientName, redirect_uris: state.clients[clientId].redirectUris, token_endpoint_auth_method: method, grant_types: state.clients[clientId].grantTypes };
  }

  authorize(input) {
    const state = this.#read();
    const client = state.clients[input.client_id];
    if (!client || input.response_type !== 'code' || input.code_challenge_method !== 'S256'
      || typeof input.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.code_challenge)
      || !client.redirectUris.includes(input.redirect_uri)) throw new Error('invalid authorization request');
    this.#prunePending();
    const requestId = token();
    this.pending.set(requestId, { expiresAt: this.now() + PENDING_TTL_MS, clientId: client.clientId, redirectUri: input.redirect_uri, state: input.state, codeChallenge: input.code_challenge });
    return `${this.publicBaseUrl}/login?req=${encodeURIComponent(requestId)}`;
  }

  loginPage(requestId, error = '') {
    this.#prunePending();
    const pending = this.pending.get(requestId);
    const client = pending ? this.#read().clients[pending.clientId] : null;
    const host = pending ? new URL(pending.redirectUri).hostname : '';
    const app = pending ? `<p class="app"><strong>${htmlEscape(client?.clientName || host)}</strong> (${htmlEscape(host)}) wants to use Field Browser Bridge.</p>` : '';
    const alert = error ? `<p class="err" role="alert">${htmlEscape(error)}</p>` : '';
    const form = pending ? `<form method="post" action="/login"><input type="hidden" name="req" value="${htmlEscape(requestId)}"><label for="passphrase">Passphrase</label><input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required><button type="submit">Sign in</button></form>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Field Browser Bridge</title><style>body{font:20px/1.5 system-ui,sans-serif;background:#111;color:#fff;margin:0;padding:24px}main{max-width:32rem;margin:8vh auto}h1{font-size:1.6em}label{display:block;font-weight:700;margin:1em 0 .3em}input{width:100%;box-sizing:border-box;font-size:1.2em;padding:.6em;border:3px solid #fff;border-radius:8px;background:#000;color:#fff}button{margin-top:1em;width:100%;font-size:1.2em;font-weight:700;padding:.7em;border:0;border-radius:8px;background:#ffd400;color:#000}.err{background:#5a0000;border:3px solid #ff6b6b;padding:.6em;border-radius:8px}.app{color:#ddd}</style></head><body><main><h1>Sign in to Field Browser Bridge</h1>${app}${alert}${form}</main></body></html>`;
  }

  async login({ requestId, passphrase, ip }) {
    this.#prunePending();
    const pending = this.pending.get(requestId);
    if (!pending) return { status: 400, html: this.loginPage('', 'This sign-in link expired. Start the connection again from the app.') };
    this.#pruneFailures();
    const failureIp = String(ip || 'unknown');
    const ipFailures = this.failures.get(failureIp) || [];
    if (ipFailures.length >= MAX_FAILURES || this.globalFailures.length >= MAX_GLOBAL_FAILURES) return { status: 429, html: this.loginPage(requestId, 'Too many wrong tries. Wait 15 minutes, then try again.') };
    if (!this.passphrase || !equal(String(passphrase || '').trim(), this.passphrase)) {
      ipFailures.push(this.now());
      this.failures.set(failureIp, ipFailures);
      this.globalFailures.push(this.now());
      await this.delay(1_000);
      return { status: 401, html: this.loginPage(requestId, 'That passphrase did not match. Try again.') };
    }
    this.pending.delete(requestId);
    const rawCode = token();
    const state = this.#read();
    state.codes[digest(rawCode)] = { clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, expiresAt: this.now() + CODE_TTL_MS };
    this.#write(state);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', rawCode);
    if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
    return { status: 302, location: redirect.toString() };
  }

  exchange(input, authorization) {
    const state = this.#read();
    const { clientId, client } = this.#authenticateClient(state, input, authorization);
    if (input.grant_type === 'authorization_code') {
      const [codeDigest, code] = findDigestRecord(state.codes, input.code || '');
      if (!code || code.expiresAt <= this.now() || code.clientId !== clientId || code.redirectUri !== input.redirect_uri
        || !equalEncoded(pkceChallenge(input.code_verifier || ''), code.codeChallenge)) throw new Error('invalid_grant');
      delete state.codes[codeDigest];
      const issued = this.#issueTokens(state, client);
      this.#write(state);
      return issued;
    }
    if (input.grant_type === 'refresh_token') {
      const [oldDigest, refresh] = findDigestRecord(state.refreshTokens, input.refresh_token || '');
      if (!refresh || refresh.clientId !== clientId) throw new Error('invalid_grant');
      delete state.refreshTokens[oldDigest];
      const issued = this.#issueTokens(state, client);
      this.#write(state);
      return issued;
    }
    throw new Error('unsupported_grant_type');
  }

  authenticate(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 32) return null;
    const supplied = Buffer.from(digest(rawToken), 'hex');
    const state = this.#read();
    for (const [storedDigest, record] of Object.entries(state.accessTokens)) {
      const expected = Buffer.from(storedDigest, 'hex');
      const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      if (matches && record.expiresAt > this.now()) {
        const client = state.clients[record.clientId];
        if (!client) return null;
        return { id: `oauth:${client.clientId}`, displayName: client.clientName, clientId: client.clientId, capabilities: [...(client.capabilities || this.capabilities)], source: 'oauth' };
      }
    }
    return null;
  }

  revoke(rawToken) {
    const state = this.#read();
    const [accessDigest, access] = findDigestRecord(state.accessTokens, rawToken || '');
    const [refreshDigest, refresh] = findDigestRecord(state.refreshTokens, rawToken || '');
    const existed = Boolean(access || refresh);
    if (accessDigest) delete state.accessTokens[accessDigest];
    if (refreshDigest) delete state.refreshTokens[refreshDigest];
    if (existed) this.#write(state);
  }

  listClients() {
    const state = this.#read();
    const counts = {};
    for (const record of Object.values(state.accessTokens)) if (record.expiresAt > this.now()) counts[record.clientId] = (counts[record.clientId] || 0) + 1;
    return Object.values(state.clients).map((c) => ({ clientId: c.clientId, displayName: c.clientName, capabilities: [...(c.capabilities || this.capabilities)], activeTokens: counts[c.clientId] || 0 }));
  }

  grantClient(clientId, capabilities) {
    const state = this.#read();
    const client = state.clients[clientId];
    if (!client) throw new Error('OAuth client was not found');
    client.capabilities = normalizeCapabilities(capabilities);
    this.#write(state);
    return { clientId, displayName: client.clientName, capabilities: [...client.capabilities] };
  }

  revokeClient(clientId) {
    const state = this.#read();
    if (!state.clients[clientId]) return false;
    for (const [key, record] of Object.entries(state.accessTokens)) if (record.clientId === clientId) delete state.accessTokens[key];
    for (const [key, record] of Object.entries(state.refreshTokens)) if (record.clientId === clientId) delete state.refreshTokens[key];
    delete state.clients[clientId];
    this.#write(state);
    return true;
  }

  #issueTokens(state, client) {
    const accessToken = token();
    const refreshToken = token();
    const agentId = `oauth:${client.clientId}`;
    state.accessTokens[digest(accessToken)] = { clientId: client.clientId, agentId, capabilities: this.capabilities, expiresAt: this.now() + ACCESS_TTL_MS };
    state.refreshTokens[digest(refreshToken)] = { clientId: client.clientId, agentId, capabilities: this.capabilities };
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken };
  }

  #authenticateClient(state, input, authorization) {
    let clientId = input.client_id;
    let clientSecret = input.client_secret;
    if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      [clientId, clientSecret] = decoded.split(/:(.*)/s, 2);
    }
    const client = state.clients[clientId];
    if (!client) throw new Error('invalid_client');
    if (client.tokenEndpointAuthMethod !== 'none' && (!clientSecret || !equalDigest(clientSecret, client.clientSecretDigest))) throw new Error('invalid_client');
    return { clientId, client };
  }

  #prunePending() { for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(key); }
  #pruneFailures() {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    for (const [ip, values] of this.failures) {
      const current = values.filter((value) => value > cutoff);
      if (current.length) this.failures.set(ip, current);
      else this.failures.delete(ip);
    }
    this.globalFailures = this.globalFailures.filter((value) => value > cutoff);
  }
  #pruneRegistrations() {
    const cutoff = this.now() - REGISTRATION_WINDOW_MS;
    for (const [ip, values] of this.registrations) {
      const current = values.filter((value) => value > cutoff);
      if (current.length) this.registrations.set(ip, current);
      else this.registrations.delete(ip);
    }
  }
  #read() {
    if (!this.stateFile || !existsSync(this.stateFile)) return emptyState();
    try { return validateState(JSON.parse(readFileSync(this.stateFile, 'utf8'))); }
    catch (error) { throw new Error(`OAuth state is unreadable: ${error.message}`); }
  }
  #write(state) {
    const now = this.now();
    for (const [key, value] of Object.entries(state.accessTokens)) if (value.expiresAt <= now) delete state.accessTokens[key];
    for (const [key, value] of Object.entries(state.codes)) if (value.expiresAt <= now) delete state.codes[key];
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }
}
