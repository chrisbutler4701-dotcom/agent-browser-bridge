import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OAuthProvider, parseOAuthCapabilities } from '../broker/src/oauth.js';

const base = 'https://bridge.example.com';
const verifier = 'correct-horse-battery-staple-verifier-1234567890';
const challenge = createHash('sha256').update(verifier).digest('base64url');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-oauth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const delays = [];
  const options = {
    publicBaseUrl: base,
    passphrase: 'synthetic-passphrase',
    stateFile: join(directory, 'oauth.json'),
    now: () => now,
    delay: async (ms) => { delays.push(ms); }
  };
  return { options, stateFile: options.stateFile, delays, advance(ms) { now += ms; } };
}

function begin(provider, registration) {
  const authorization = provider.authorize({
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: 'synthetic-state'
  });
  return new URL(authorization).searchParams.get('req');
}

async function connect(provider, name) {
  const registration = provider.register({ client_name: name, redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none' });
  const requestId = begin(provider, registration);
  const login = await provider.login({ requestId, passphrase: 'synthetic-passphrase', ip: '203.0.113.9' });
  const code = new URL(login.location).searchParams.get('code');
  const issued = provider.exchange({ grant_type: 'authorization_code', client_id: registration.client_id, code, redirect_uri: registration.redirect_uris[0], code_verifier: verifier });
  return { registration, issued, principal: provider.authenticate(issued.access_token) };
}

test('OAuth DCR, passphrase login, PKCE, rotation, and restart persistence', async (t) => {
  const fixtureState = fixture(t);
  const provider = new OAuthProvider(fixtureState.options);
  const registration = provider.register({
    client_name: 'Synthetic MCP Client',
    redirect_uris: ['https://client.example.test/callback'],
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token']
  });
  const requestId = begin(provider, registration);
  const wrong = await provider.login({ requestId, passphrase: 'wrong-passphrase' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(fixtureState.delays, [1_000]);

  const accepted = await provider.login({ requestId, passphrase: 'synthetic-passphrase' });
  assert.equal(accepted.status, 302);
  const callback = new URL(accepted.location);
  assert.equal(callback.searchParams.get('state'), 'synthetic-state');
  const code = callback.searchParams.get('code');
  const issued = provider.exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: registration.redirect_uris[0],
    client_id: registration.client_id,
    client_secret: registration.client_secret
  });
  assert.equal(issued.token_type, 'Bearer');
  assert.equal(issued.expires_in, 3600);
  assert.throws(() => provider.exchange({
    grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: registration.redirect_uris[0], client_id: registration.client_id,
    client_secret: registration.client_secret
  }), /invalid_grant/);

  const principal = new OAuthProvider(fixtureState.options).authenticate(issued.access_token);
  assert.equal(principal.id, `oauth:${registration.client_id}`);
  assert.equal(principal.source, 'oauth');
  const refreshed = provider.exchange({
    grant_type: 'refresh_token', refresh_token: issued.refresh_token,
    client_id: registration.client_id, client_secret: registration.client_secret
  });
  assert.notEqual(refreshed.refresh_token, issued.refresh_token);
  assert.throws(() => provider.exchange({
    grant_type: 'refresh_token', refresh_token: issued.refresh_token,
    client_id: registration.client_id, client_secret: registration.client_secret
  }), /invalid_grant/);

  const persisted = readFileSync(fixtureState.stateFile, 'utf8');
  for (const secret of [registration.client_secret, code, issued.access_token, issued.refresh_token, refreshed.access_token, refreshed.refresh_token]) {
    assert.equal(persisted.includes(secret), false, 'raw OAuth credentials must never be persisted');
  }
  assert.equal(statSync(fixtureState.stateFile).mode & 0o777, 0o600);
});

test('OAuth rejects unsafe redirects and locks login after five failures', async (t) => {
  const fixtureState = fixture(t);
  const provider = new OAuthProvider(fixtureState.options);
  assert.throws(() => provider.register({ redirect_uris: ['http://example.test/callback'] }), /HTTPS or loopback HTTP/);
  const registration = provider.register({
    client_name: 'Loopback Client', redirect_uris: ['http://127.0.0.1:43123/callback'],
    token_endpoint_auth_method: 'none'
  });
  const requestId = begin(provider, registration);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await provider.login({ requestId, passphrase: 'wrong' });
    assert.equal(result.status, 401);
  }
  const locked = await provider.login({ requestId, passphrase: 'synthetic-passphrase' });
  assert.equal(locked.status, 429);
  assert.match(locked.html, /role="alert"/);
  fixtureState.advance(15 * 60_000 + 1);
  const expired = await provider.login({ requestId, passphrase: 'synthetic-passphrase' });
  assert.equal(expired.status, 400, 'the parked authorization request expires independently after ten minutes');
});

test('OAuth metadata and accessible login page expose the required contract', (t) => {
  const fixtureState = fixture(t);
  const provider = new OAuthProvider(fixtureState.options);
  const registration = provider.register({ client_name: 'Accessible Client', redirect_uris: ['https://app.example.test/oauth/callback'] });
  const requestId = begin(provider, registration);
  const page = provider.loginPage(requestId, 'Synthetic error');
  assert.match(page, /font:20px/);
  assert.match(page, /<label for="passphrase">/);
  assert.match(page, /autocomplete="current-password"/);
  assert.match(page, /autofocus/);
  assert.match(page, /role="alert"/);
  assert.match(page, /Accessible Client/);
  assert.match(page, /app\.example\.test/);
  assert.deepEqual(provider.metadata('/.well-known/oauth-protected-resource/mcp'), {
    resource: `${base}/mcp`, authorization_servers: [base]
  });
  assert.deepEqual(provider.metadata('/.well-known/oauth-authorization-server').code_challenge_methods_supported, ['S256']);
});

test('two web apps with the same display name are two distinct agents', async (t) => {
  const provider = new OAuthProvider(fixture(t).options);
  const first = await connect(provider, 'Claude');
  const second = await connect(provider, 'Claude');
  assert.notEqual(first.principal.id, second.principal.id);
  assert.equal(first.principal.id, `oauth:${first.registration.client_id}`);
  assert.equal(first.principal.displayName, 'Claude');
  assert.equal(first.principal.clientId, first.registration.client_id);
});

test('web apps start read-only; grants apply to live tokens; revoke kills them', async (t) => {
  const provider = new OAuthProvider(fixture(t).options);
  const { registration, issued, principal } = await connect(provider, 'ChatGPT');
  assert.deepEqual(principal.capabilities, ['browser.read']);
  provider.grantClient(registration.client_id, ['browser.read', 'browser.control']);
  assert.deepEqual(provider.authenticate(issued.access_token).capabilities.sort(), ['browser.control', 'browser.read']);
  const listed = provider.listClients().find((c) => c.clientId === registration.client_id);
  assert.equal(listed.displayName, 'ChatGPT');
  assert.equal(JSON.stringify(provider.listClients()).includes(issued.access_token), false);
  assert.equal(provider.revokeClient(registration.client_id), true);
  assert.equal(provider.authenticate(issued.access_token), null);
  assert.throws(() => provider.exchange({ grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: issued.refresh_token }), /invalid/);
});

test('an explicit FBB_OAUTH_CAPABILITIES still sets the default for new clients', () => {
  assert.deepEqual(parseOAuthCapabilities(''), ['browser.read']);
  assert.deepEqual(parseOAuthCapabilities('browser.read,browser.control').sort(), ['browser.control', 'browser.read']);
  assert.throws(() => parseOAuthCapabilities('browser.read,private_browser_local'), /cannot include private_browser_local/u);
});

test('a stranger cannot lock the owner out of sign-in', async (t) => {
  const provider = new OAuthProvider(fixture(t).options);
  const registration = provider.register({ client_name: 'Claude', redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none' }, { ip: '203.0.113.1' });
  for (let i = 0; i < 6; i += 1) await provider.login({ requestId: begin(provider, registration), passphrase: 'wrong', ip: '198.51.100.66' });
  const blocked = await provider.login({ requestId: begin(provider, registration), passphrase: 'synthetic-passphrase', ip: '198.51.100.66' });
  assert.equal(blocked.status, 429);
  const owner = await provider.login({ requestId: begin(provider, registration), passphrase: 'synthetic-passphrase', ip: '203.0.113.9' });
  assert.equal(owner.status, 302);
});

test('registration is capped overall and per address', (t) => {
  const provider = new OAuthProvider({ ...fixture(t).options, maxClients: 3, registrationsPerIpPerHour: 2 });
  const reg = (ip) => provider.register({ client_name: 'X', redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none' }, { ip });
  reg('198.51.100.1'); reg('198.51.100.1');
  assert.throws(() => reg('198.51.100.1'), (error) => error.status === 429);
  reg('198.51.100.2');
  assert.throws(() => reg('198.51.100.3'), /client limit/);
});
