import { isIP } from 'node:net';

const bare = (value) => String(value || '').trim().replace(/^::ffff:/, '');

// Trust X-Forwarded-For only when the direct peer is a configured proxy, and take
// the right-most address that is not itself a trusted proxy.
export function clientIp(req, trustedProxies = []) {
  const peer = bare(req?.socket?.remoteAddress);
  const trusted = new Set(trustedProxies.map(bare).filter(Boolean));
  if (!trusted.has(peer)) return peer || 'unknown';
  const chain = String(req.headers?.['x-forwarded-for'] || '').split(',').map(bare).filter((ip) => isIP(ip));
  for (let i = chain.length - 1; i >= 0; i -= 1) if (!trusted.has(chain[i])) return chain[i];
  return peer || 'unknown';
}
