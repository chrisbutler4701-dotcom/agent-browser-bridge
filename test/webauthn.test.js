import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { verifyAssertion, verifyRegistration } from '../broker/src/webauthn.js';

function cborLength(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65_536) { const output = Buffer.alloc(3); output[0] = (major << 5) | 25; output.writeUInt16BE(length, 1); return output; }
  const output = Buffer.alloc(5); output[0] = (major << 5) | 26; output.writeUInt32BE(length, 1); return output;
}

function cbor(value) {
  if (Number.isInteger(value)) return value >= 0 ? cborLength(0, value) : cborLength(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborLength(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([cborLength(3, bytes.length), bytes]); }
  if (Array.isArray(value)) return Buffer.concat([cborLength(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([cborLength(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new TypeError('unsupported CBOR test value');
}

function softwareAuthenticator({ challenge = randomBytes(32).toString('base64url'), origin = 'https://browser.example.test', rpId = 'browser.example.test', flags = 0x45, alg = -7, signCount = 0 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(24);
  const coseKey = cbor(new Map([
    [1, 2], [3, alg], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]
  ]));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(signCount);
  const credentialLength = Buffer.alloc(2); credentialLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(), Buffer.from([flags]), counter,
    Buffer.alloc(16), credentialLength, credentialId, coseKey
  ]);
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
  const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url');

  function assertion(assertionCount, assertionChallenge = challenge, assertionOrigin = origin, assertionRpId = rpId, assertionFlags = 0x05) {
    const assertionCounter = Buffer.alloc(4); assertionCounter.writeUInt32BE(assertionCount);
    const authenticatorData = Buffer.concat([createHash('sha256').update(assertionRpId).digest(), Buffer.from([assertionFlags]), assertionCounter]);
    const assertionClientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: assertionChallenge, origin: assertionOrigin }));
    const signed = Buffer.concat([authenticatorData, createHash('sha256').update(assertionClientData).digest()]);
    return {
      authenticatorData: authenticatorData.toString('base64url'),
      clientDataJSON: assertionClientData.toString('base64url'),
      signature: sign('sha256', signed, privateKey).toString('base64url')
    };
  }

  return {
    challenge, origin, rpId, credentialId: credentialId.toString('base64url'),
    attestationObject, clientDataJSON: clientData.toString('base64url'), assertion
  };
}

function registration(input) {
  return verifyRegistration({
    attestationObject: input.attestationObject,
    clientDataJSON: input.clientDataJSON,
    expectedChallenge: input.challenge,
    rpId: input.rpId,
    origin: input.origin
  });
}

function assertInvalid(run) {
  assert.throws(run, (error) => error.message === 'passkey_invalid' && typeof error.cause === 'string');
}

test('valid ES256 registration returns the credential id, public key, and counter', () => {
  const authenticator = softwareAuthenticator({ signCount: 7 });
  const result = registration(authenticator);
  assert.equal(result.credentialId, authenticator.credentialId);
  assert.deepEqual(Object.keys(result.publicKeyJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(result.publicKeyJwk.kty, 'EC');
  assert.equal(result.publicKeyJwk.crv, 'P-256');
  assert.equal(result.signCount, 7);
});

test('registration rejects the wrong challenge, origin, rpId hash, or a missing UV flag', () => {
  const valid = softwareAuthenticator();
  assertInvalid(() => verifyRegistration({ attestationObject: valid.attestationObject, clientDataJSON: valid.clientDataJSON, expectedChallenge: 'wrong', rpId: valid.rpId, origin: valid.origin }));
  assertInvalid(() => verifyRegistration({ attestationObject: valid.attestationObject, clientDataJSON: valid.clientDataJSON, expectedChallenge: valid.challenge, rpId: valid.rpId, origin: 'https://wrong.example.test' }));
  assertInvalid(() => verifyRegistration({ attestationObject: valid.attestationObject, clientDataJSON: valid.clientDataJSON, expectedChallenge: valid.challenge, rpId: 'wrong.example.test', origin: valid.origin }));
  const missingUv = softwareAuthenticator({ flags: 0x41 });
  assertInvalid(() => registration(missingUv));
});

test('registration rejects a non-ES256 credential algorithm', () => {
  assertInvalid(() => registration(softwareAuthenticator({ alg: -257 })));
});

test('a valid assertion verifies and returns its increased sign count', () => {
  const authenticator = softwareAuthenticator();
  const credential = registration(authenticator);
  const result = verifyAssertion({
    credential,
    ...authenticator.assertion(1),
    expectedChallenge: authenticator.challenge,
    rpId: authenticator.rpId,
    origin: authenticator.origin
  });
  assert.deepEqual(result, { signCount: 1 });
});

test('an assertion with a lower sign count is rejected', () => {
  const authenticator = softwareAuthenticator();
  const credential = { ...registration(authenticator), signCount: 5 };
  assertInvalid(() => verifyAssertion({
    credential,
    ...authenticator.assertion(4),
    expectedChallenge: authenticator.challenge,
    rpId: authenticator.rpId,
    origin: authenticator.origin
  }));
});
