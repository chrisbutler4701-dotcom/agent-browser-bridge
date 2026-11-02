import { ALLOW_PRIVATE_HTTP, HOSTED_INGEST_URL } from './hosted-default.js';

const LOOPBACK_HTTP_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})(?:\/[^\s?#]*)?$/i;
const PRIVATE_HTTP_URL = /^http:\/\/[^/:?#]+:([0-9]{1,5})(?:\/[^\s?#]*)?$/i;
const HOSTED_ORIGIN = HOSTED_INGEST_URL ? new URL(HOSTED_INGEST_URL).origin : '';

export function validateBrokerUrl(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || /\s/.test(value)) return false;
  if (!/^https?:\/\/[^/]/i.test(value)) return false;
  let target;
  try { target = new URL(value); } catch { return false; }
  if (target.username || target.password || target.search || target.hash) return false;
  if (target.protocol === 'https:') return true;
  const loopbackMatch = LOOPBACK_HTTP_URL.exec(value);
  const privateMatch = ALLOW_PRIVATE_HTTP ? PRIVATE_HTTP_URL.exec(value) : null;
  const match = loopbackMatch || privateMatch;
  if (!match || target.protocol !== 'http:') return false;
  if (!privateMatch && !['127.0.0.1', 'localhost'].includes(target.hostname)) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

export function normalizeBrokerUrl(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return value;
  if (HOSTED_ORIGIN && (value === HOSTED_ORIGIN || value === `${HOSTED_ORIGIN}/` || value === `${HOSTED_ORIGIN}/work-edge`)) return HOSTED_INGEST_URL;
  return value;
}

export function brokerOrigin(brokerUrl) {
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) return null;
  return new URL(brokerUrl).origin;
}

export function pairExchangeUrl(brokerUrl) {
  const origin = brokerOrigin(brokerUrl);
  return origin ? `${origin}/work-edge/pair/exchange` : null;
}

export function websocketEndpointUrl(brokerUrl) {
  const origin = brokerOrigin(brokerUrl);
  if (!origin) return null;
  const target = new URL(origin);
  return `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}/work-edge/ws`;
}

export function verifiedActionEndpointUrl(brokerUrl, action) {
  const origin = brokerOrigin(brokerUrl);
  if (!origin || !['pending', 'approve', 'reject'].includes(action)) return null;
  return `${origin}/work-edge/verified-actions/${action}`;
}
