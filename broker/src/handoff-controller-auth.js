import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_CLOCK_SKEW_MS = 60_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function signature(secret, req, id, timestamp) {
  return createHmac('sha256', secret)
    .update(`${req.method}\n${req.url}\n${id}\n${timestamp}`)
    .digest('hex');
}

// The caller cannot choose an identity: a hosting surface first validates its
// own human session, then signs that resulting opaque controller id using this
// private server-to-server credential. This intentionally does not accept an
// MCP/agent bearer, paired-extension token, browser id, or request body.
export function createHmacHandoffControllerAuthenticator(env = process.env, now = () => Date.now()) {
  const secret = env.WORK_EDGE_HANDOFF_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return () => null;
  return (req) => {
    const id = header(req, 'x-work-edge-handoff-controller');
    const timestamp = header(req, 'x-work-edge-handoff-timestamp');
    const supplied = header(req, 'x-work-edge-handoff-signature');
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !/^\d{13}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/i.test(supplied || '')) return null;
    if (Math.abs(now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return null;
    const expected = signature(secret, req, id, timestamp);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) return null;
    return { id };
  };
}

// Kept for a hosting surface's private server-side request path; never send
// the credential or this helper to a browser client.
export function signHandoffControllerRequest(secret, { method, url, id, timestamp = Date.now() }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('handoff credential is unavailable');
  if (!ID_PATTERN.test(id) || !Number.isInteger(timestamp)) throw new TypeError('handoff controller is invalid');
  const req = { method, url };
  return {
    'x-work-edge-handoff-controller': id,
    'x-work-edge-handoff-timestamp': String(timestamp),
    'x-work-edge-handoff-signature': signature(secret, req, id, String(timestamp))
  };
}
