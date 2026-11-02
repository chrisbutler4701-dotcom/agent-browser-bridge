import { createHash, randomBytes } from 'node:crypto';

export const RUN_LANES = Object.freeze({
  claude: Object.freeze(['browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute']),
  codex: Object.freeze(['browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute']),
  agy: Object.freeze(['browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute']),
  hermes: Object.freeze(['browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute']),
});

export function scopeRunBrowserArgs(principal, suppliedArgs = {}) {
  if (principal?.source !== 'run-grant') return { args: suppliedArgs, allowed: true };
  return { args: { ...suppliedArgs, browserId: principal.browserId },
    allowed: suppliedArgs.browserId === undefined || suppliedArgs.browserId === principal.browserId };
}

export function visibleRunBrowsers(principal, browsers) {
  return principal?.source === 'run-grant' ? browsers.filter((browser) => browser.id === principal.browserId) : browsers;
}

const digest = (token) => createHash('sha256').update(token).digest('hex');
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const BROWSER_ID = /^brw_[a-f0-9]{16}$/u;
const MAX_GRANTS_PER_ISSUER = 50;
const RUN_REUSE_WINDOW_MS = (1800 + 60) * 1000;

export function createRunGrants({ now = () => Date.now() } = {}) {
  const grants = new Map();
  const byRun = new Map();
  const usedRuns = new Map();
  function prune() {
    const current = now();
    for (const [key, grant] of grants) if (grant.expiresAt <= current) {
      grants.delete(key); byRun.delete(grant.runId);
    }
    for (const [runId, reusableAt] of usedRuns) if (reusableAt <= current) usedRuns.delete(runId);
  }
  function revoke(runId, issuerId) {
    const key = byRun.get(runId);
    const grant = key && grants.get(key);
    if (!grant || grant.issuerId !== issuerId) return false;
    grants.delete(key); byRun.delete(runId);
    return true;
  }
  return {
    issue({ runId, browserId, lane, ttlSeconds, issuerId, issuerVersion, issuerCapabilities }) {
      if (typeof runId !== 'string' || !RUN_ID.test(runId) || typeof browserId !== 'string' || !BROWSER_ID.test(browserId) || !Object.hasOwn(RUN_LANES, lane)
        || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800 || !issuerId) {
        throw new TypeError('Invalid run grant request.');
      }
      prune();
      if (usedRuns.has(runId)) throw new Error('Run id has already been granted.');
      if ([...grants.values()].filter((grant) => grant.issuerId === issuerId).length >= MAX_GRANTS_PER_ISSUER) throw new Error('Issuer has too many live run grants.');
      const capabilities = RUN_LANES[lane].filter((capability) => issuerCapabilities?.includes(capability));
      if (!capabilities.length) throw new Error('Issuer has no browser authority for this lane.');
      const bearer = `fbg_${randomBytes(32).toString('base64url')}`;
      const key = digest(bearer);
      const expiresAt = now() + ttlSeconds * 1000;
      grants.set(key, { runId, browserId, lane, issuerId, issuerVersion, expiresAt, capabilities });
      byRun.set(runId, key);
      usedRuns.set(runId, now() + RUN_REUSE_WINDOW_MS);
      return { bearer, expires_at: new Date(expiresAt).toISOString() };
    },
    authorize(token) {
      if (typeof token !== 'string' || !/^fbg_[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const key = digest(token);
      const grant = grants.get(key);
      if (!grant) return null;
      if (grant.expiresAt <= now()) { revoke(grant.runId, grant.issuerId); return null; }
      return { ...grant, id: `fbg:${key}`, capabilities: grant.capabilities, source: 'run-grant' };
    },
    revoke,
    prune,
  };
}
