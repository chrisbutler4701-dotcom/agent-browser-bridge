import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerSessions } from '../broker/src/owner-session.js';
import { PasskeyStore } from '../broker/src/passkey-store.js';
import { createServer } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

function cborLength(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const output = Buffer.alloc(3); output[0] = (major << 5) | 25; output.writeUInt16BE(length, 1); return output;
}

function cbor(value) {
  if (Number.isInteger(value)) return value >= 0 ? cborLength(0, value) : cborLength(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborLength(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([cborLength(3, bytes.length), bytes]); }
  if (value instanceof Map) return Buffer.concat([cborLength(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new TypeError('unsupported CBOR test value');
}

function registration(challenge, origin, rpId) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(24);
  const coseKey = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credentialLength = Buffer.alloc(2); credentialLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4),
    Buffer.alloc(16), credentialLength, credentialId, coseKey
  ]);
  return {
    credentialId: credentialId.toString('base64url'),
    publicX: jwk.x,
    attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url'),
    clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
    label: 'Owner phone'
  };
}

const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['*'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includeUrlPath: false }
};
const jsonHeaders = { 'content-type': 'application/json' };
const bearer = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });
const body = (value) => JSON.stringify(value);
const json = (response) => JSON.parse(response.body);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-owner-passkeys-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'passkeys.json');
  const passkeyStore = new PasskeyStore({ filePath });
  const ownerSessions = new OwnerSessions({ passphrase: 'owner passphrase for passkeys', delay: async () => {} });
  const auditLines = [];
  const server = createServer({
    policy,
    ownerSessions,
    passkeyStore,
    auditWriter: (line) => auditLines.push(line),
    env: { PUBLIC_BASE_URL: 'https://browser.example.test', FBB_RP_ID: 'browser.example.test', FBB_DATA_DIR: directory, FBB_PASSKEY_APPROVALS: '1' }
  });
  t.after(() => server.close());
  return { server, ownerSessions, passkeyStore, filePath, auditLines };
}

async function ownerToken(state) {
  return (await state.ownerSessions.signIn({ passphrase: 'owner passphrase for passkeys', ip: '127.0.0.1' })).token;
}

function seedPasskey(state, label = 'LABEL-XYZ') {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  return state.passkeyStore.add({
    credentialId: randomBytes(24).toString('base64url'),
    publicKeyJwk,
    signCount: 0,
    label
  });
}

test('owner passkey page is a public data-free sign-in and registration shell', async (t) => {
  const state = fixture(t);
  const stored = seedPasskey(state);

  const page = await invoke(state.server, { url: '/work-edge/owner/passkeys' });

  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(page.body, /Owner passphrase[\s\S]*type="password"[\s\S]*autocomplete="current-password"/);
  assert.match(page.body, /Passkey label/);
  assert.match(page.body, /Sign in and add a passkey on this device/);
  assert.match(page.body, /<ul id="passkeys"><\/ul>/);
  assert.match(page.body, /role="status"/);
  assert.equal(page.body.includes(stored.label), false);
  assert.equal(page.body.includes(stored.credentialId), false);
});

test('owner passkey list requires a session and returns public passkey fields', async (t) => {
  const state = fixture(t);
  const stored = seedPasskey(state);

  const denied = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/passkeys/list', headers: jsonHeaders, body: '{}'
  });
  assert.equal(denied.status, 401);

  const token = await ownerToken(state);
  const listed = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/passkeys/list', headers: bearer(token), body: '{}'
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(json(listed), { passkeys: [{
    credentialId: stored.credentialId,
    label: 'LABEL-XYZ',
    createdAt: stored.createdAt
  }] });
  assert.deepEqual(state.auditLines.map((line) => JSON.parse(line).tool), ['owner_passkey_list', 'owner_passkey_list']);
});

test('owner registration options create and store a valid passkey', async (t) => {
  const state = fixture(t);
  const token = await ownerToken(state);
  const page = await invoke(state.server, { url: '/work-edge/owner/passkeys', headers: bearer(token) });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /navigator\.credentials\.create/);
  assert.match(page.body, /userVerification: 'required'/);

  const optionsResponse = await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys/options', headers: bearer(token), body: '{}' });
  assert.equal(optionsResponse.status, 200);
  const options = json(optionsResponse).publicKey;
  assert.equal(options.rp.id, 'browser.example.test');
  assert.equal(options.rp.name, 'Field Browser Bridge');
  assert.deepEqual(options.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
  assert.deepEqual(options.authenticatorSelection, { userVerification: 'required', residentKey: 'preferred' });

  const created = registration(options.challenge, 'https://browser.example.test', 'browser.example.test');
  const response = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/passkeys', headers: bearer(token),
    body: body({ attestationObject: created.attestationObject, clientDataJSON: created.clientDataJSON, label: created.label })
  });
  assert.equal(response.status, 201);
  assert.deepEqual(json(response), { credentialId: created.credentialId, label: 'Owner phone', createdAt: state.passkeyStore.list()[0].createdAt });
  assert.equal(state.passkeyStore.list().length, 1);
  assert.equal(state.passkeyStore.list()[0].credentialId, created.credentialId);
  assert.equal(statSync(state.filePath).mode & 0o777, 0o600);
});

test('owner can remove a registered passkey', async (t) => {
  const state = fixture(t);
  const token = await ownerToken(state);
  const options = json(await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys/options', headers: bearer(token), body: '{}' })).publicKey;
  const created = registration(options.challenge, 'https://browser.example.test', 'browser.example.test');
  await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys', headers: bearer(token), body: body(created) });
  const removed = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/passkeys/remove', headers: bearer(token), body: body({ credentialId: created.credentialId })
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(json(removed), { removed: true });
  assert.deepEqual(state.passkeyStore.list(), []);
});

test('passkey owner routes refuse requests without an owner session', async (t) => {
  const { server } = fixture(t);
  const routes = [
    { method: 'POST', url: '/work-edge/owner/passkeys/list', body: '{}' },
    { method: 'POST', url: '/work-edge/owner/passkeys/options', body: '{}' },
    { method: 'POST', url: '/work-edge/owner/passkeys', body: '{}' },
    { method: 'POST', url: '/work-edge/owner/passkeys/remove', body: '{}' }
  ];
  for (const route of routes) {
    const response = await invoke(server, { ...route, headers: jsonHeaders });
    assert.equal(response.status, 401, `${route.method} ${route.url}`);
  }
});

test('passkey audit lines contain no credential or key material', async (t) => {
  const state = fixture(t);
  const token = await ownerToken(state);
  const options = json(await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys/options', headers: bearer(token), body: '{}' })).publicKey;
  const created = registration(options.challenge, 'https://browser.example.test', 'browser.example.test');
  await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys', headers: bearer(token), body: body(created) });
  const stored = readFileSync(state.filePath, 'utf8');
  await invoke(state.server, { method: 'POST', url: '/work-edge/owner/passkeys/remove', headers: bearer(token), body: body({ credentialId: created.credentialId }) });
  const audit = state.auditLines.join('');
  assert.match(audit, /"tool":"owner_passkey_register"/);
  assert.match(audit, /"tool":"owner_passkey_remove"/);
  assert.equal(audit.includes(created.credentialId), false);
  assert.equal(audit.includes(created.publicX), false);
  assert.equal(audit.includes(created.attestationObject), false);
  assert.equal(audit.includes(created.clientDataJSON), false);
  assert.equal(stored.includes(created.publicX), true);
});
