import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 15 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 100;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const equal = (left, right) => {
  const actual = Buffer.from(digest(left), 'hex');
  const expected = Buffer.from(digest(right), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export class OwnerSessions {
  constructor({ passphrase, loginPassphrase, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.passphrase = typeof passphrase === 'string' ? passphrase : '';
    this.conflictsWithLogin = Boolean(this.passphrase && typeof loginPassphrase === 'string' && loginPassphrase && equal(this.passphrase, loginPassphrase));
    this.now = now;
    this.delay = delay;
    this.sessions = new Map();
    this.failures = new Map();
    this.globalFailures = [];
  }

  async signIn({ passphrase, ip }) {
    if (!this.passphrase) return { status: 503, error: 'Owner sign-in is turned off on this server.' };
    if (this.conflictsWithLogin) return { status: 503, error: 'Owner sign-in needs its own passphrase, different from the app sign-in passphrase.' };
    this.#pruneFailures();
    const failureIp = String(ip || 'unknown');
    const ipFailures = this.failures.get(failureIp) || [];
    if (ipFailures.length >= MAX_FAILURES || this.globalFailures.length >= MAX_GLOBAL_FAILURES) {
      return { status: 429, error: 'Too many wrong tries. Wait 15 minutes, then try again.' };
    }
    if (!equal(String(passphrase || '').trim(), this.passphrase)) {
      const failedAt = this.now();
      ipFailures.push(failedAt);
      this.failures.set(failureIp, ipFailures);
      this.globalFailures.push(failedAt);
      await this.delay(1_000);
      return { status: 401, error: 'That passphrase did not match. Try again.' };
    }
    this.#pruneSessions();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(digest(token), expiresAt);
    return { status: 200, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  authenticate(token) {
    if (typeof token !== 'string' || !token) return false;
    this.#pruneSessions();
    return this.sessions.has(digest(token));
  }

  signOut(token) {
    if (typeof token === 'string' && token) this.sessions.delete(digest(token));
  }

  #pruneSessions() {
    for (const [sessionDigest, expiresAt] of this.sessions) if (expiresAt <= this.now()) this.sessions.delete(sessionDigest);
  }

  #pruneFailures() {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    for (const [ip, values] of this.failures) {
      const current = values.filter((value) => value > cutoff);
      if (current.length) this.failures.set(ip, current);
      else this.failures.delete(ip);
    }
    this.globalFailures = this.globalFailures.filter((value) => value > cutoff);
  }
}
