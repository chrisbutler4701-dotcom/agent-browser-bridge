import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

function invalid(reason) {
  return new Error('passkey_invalid', { cause: reason });
}

function base64url(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(`${name} is not base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value) throw invalid(`${name} is not canonical base64url`);
  return decoded;
}

function lengthAt(buffer, offset, additional) {
  if (additional < 24) return { length: additional, offset };
  const bytes = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (!bytes || offset + bytes > buffer.length) throw new Error('unsupported or truncated CBOR length');
  if (bytes === 8) {
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR length is too large');
    return { length: Number(value), offset: offset + bytes };
  }
  return { length: buffer.readUIntBE(offset, bytes), offset: offset + bytes };
}

function decodeAt(buffer, start) {
  if (start >= buffer.length) throw new Error('truncated CBOR value');
  const initial = buffer[start];
  const major = initial >> 5;
  const sized = lengthAt(buffer, start + 1, initial & 31);
  let offset = sized.offset;
  if (major === 0) return { value: sized.length, offset };
  if (major === 1) return { value: -1 - sized.length, offset };
  if (major === 2 || major === 3) {
    const end = offset + sized.length;
    if (end > buffer.length) throw new Error('truncated CBOR string');
    const bytes = buffer.subarray(offset, end);
    return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), offset: end };
  }
  if (major === 4) {
    const value = [];
    for (let index = 0; index < sized.length; index += 1) { const item = decodeAt(buffer, offset); value.push(item.value); offset = item.offset; }
    return { value, offset };
  }
  if (major === 5) {
    const value = new Map();
    for (let index = 0; index < sized.length; index += 1) {
      const key = decodeAt(buffer, offset); offset = key.offset;
      const item = decodeAt(buffer, offset); offset = item.offset;
      if (value.has(key.value)) throw new Error('duplicate CBOR map key');
      value.set(key.value, item.value);
    }
    return { value, offset };
  }
  throw new Error('unsupported CBOR type');
}

function decode(buffer, requireEnd = true) {
  const decoded = decodeAt(buffer, 0);
  if (requireEnd && decoded.offset !== buffer.length) throw new Error('trailing CBOR data');
  return decoded;
}

function clientData(value, expectedType, expectedChallenge, origin) {
  const bytes = base64url(value, 'clientDataJSON');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('clientDataJSON is not valid JSON'); }
  if (!parsed || parsed.type !== expectedType) throw invalid('client data type does not match');
  if (parsed.challenge !== expectedChallenge) throw invalid('challenge does not match');
  if (parsed.origin !== origin) throw invalid('origin does not match');
  return bytes;
}

function authenticatorHeader(buffer, rpId, requiredFlags) {
  if (buffer.length < 37) throw invalid('authenticator data is truncated');
  const expectedRpIdHash = createHash('sha256').update(rpId).digest();
  const suppliedRpIdHash = buffer.subarray(0, 32);
  if (!timingSafeEqual(expectedRpIdHash, suppliedRpIdHash)) throw invalid('rpId hash does not match');
  const flags = buffer[32];
  if ((flags & requiredFlags) !== requiredFlags) throw invalid('user presence, verification, or attested data is missing');
  return { flags, signCount: buffer.readUInt32BE(33) };
}

function publicKeyFromCose(cose) {
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw invalid('credential is not ES256 P-256');
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) throw invalid('credential coordinates are invalid');
  return { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
}

export function verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, rpId, origin }) {
  try {
    clientData(clientDataJSON, 'webauthn.create', expectedChallenge, origin);
    const attestation = decode(base64url(attestationObject, 'attestationObject')).value;
    if (!(attestation instanceof Map) || attestation.get('fmt') !== 'none') throw invalid('attestation format is not none');
    const statement = attestation.get('attStmt');
    if (!(statement instanceof Map) || statement.size !== 0) throw invalid('attestation statement is invalid');
    const authData = attestation.get('authData');
    if (!Buffer.isBuffer(authData)) throw invalid('authenticator data is missing');
    const { signCount } = authenticatorHeader(authData, rpId, 0x45);
    if (authData.length < 55) throw invalid('attested credential data is truncated');
    const credentialLength = authData.readUInt16BE(53);
    const credentialStart = 55;
    const credentialEnd = credentialStart + credentialLength;
    if (!credentialLength || credentialEnd >= authData.length) throw invalid('credential id is invalid');
    const credentialId = authData.subarray(credentialStart, credentialEnd).toString('base64url');
    const cose = decode(authData.subarray(credentialEnd)).value;
    return { credentialId, publicKeyJwk: publicKeyFromCose(cose), signCount };
  } catch (error) {
    if (error?.message === 'passkey_invalid') throw error;
    throw invalid(error?.message || 'registration could not be verified');
  }
}

export function verifyAssertion({ credential, authenticatorData, clientDataJSON, signature, expectedChallenge, rpId, origin }) {
  try {
    if (!credential?.publicKeyJwk || typeof credential.signCount !== 'number') throw invalid('stored credential is invalid');
    const clientBytes = clientData(clientDataJSON, 'webauthn.get', expectedChallenge, origin);
    const authBytes = base64url(authenticatorData, 'authenticatorData');
    const { signCount } = authenticatorHeader(authBytes, rpId, 0x05);
    if ((credential.signCount !== 0 || signCount !== 0) && signCount <= credential.signCount) throw invalid('signature counter did not increase');
    const signed = Buffer.concat([authBytes, createHash('sha256').update(clientBytes).digest()]);
    const key = createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
    if (!verify('sha256', signed, key, base64url(signature, 'signature'))) throw invalid('signature did not verify');
    return { signCount };
  } catch (error) {
    if (error?.message === 'passkey_invalid') throw error;
    throw invalid(error?.message || 'assertion could not be verified');
  }
}
