import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DIGEST = /^[a-f0-9]{64}$/;
const PUBLIC_ID = /^brw_[a-f0-9]{16}$/;
const DEFAULT_TOKEN_STORE = '/etc/work-edge/browser-tokens.json';

// The one place the registry location is decided, shared by the broker and the CLI.
export function registryPaths(env = process.env, tokenStorePath = env.WORK_EDGE_TOKEN_STORE || DEFAULT_TOKEN_STORE) {
  return {
    filePath: env.WORK_EDGE_BROWSER_REGISTRY || resolve(tokenStorePath, '..', 'browser-registry.json'),
    legacySelectionFile: env.WORK_EDGE_BROWSER_SELECTION || resolve(tokenStorePath, '..', 'browser-selection.json')
  };
}

// Paired browsers by token digest. Agents only ever see the opaque public id.
// The default changes only by an explicit human call; nothing here promotes a
// browser on its own, so a disconnected default can never be silently replaced.
export class BrowserRegistry {
  constructor({ filePath, legacySelectionFile = null, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.legacySelectionFile = legacySelectionFile;
    this.now = now;
  }

  #empty() {
    return { version: 1, browsers: {}, defaultDigest: null, seq: 0 };
  }

  #read() {
    if (!this.filePath || !existsSync(this.filePath)) {
      const state = this.#empty();
      if (this.legacySelectionFile && existsSync(this.legacySelectionFile)) {
        try {
          const legacy = JSON.parse(readFileSync(this.legacySelectionFile, 'utf8'));
          if (DIGEST.test(legacy?.browserId || '')) {
            this.#add(state, legacy.browserId);
            state.defaultDigest = legacy.browserId;
            // Persist the migration immediately so its random public id is stable across reads.
            if (this.filePath) this.#write(state);
          }
        } catch {
          // An unreadable legacy file cannot safely name a default.
        }
      }
      return state;
    }
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (value?.version !== 1 || typeof value.browsers !== 'object') throw new Error();
      return value;
    } catch {
      throw new Error('Browser registry is unreadable.');
    }
  }

  #write(state) {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
    chmodSync(this.filePath, 0o600);
  }

  #add(state, digest) {
    state.seq += 1;
    state.browsers[digest] = {
      id: `brw_${randomBytes(8).toString('hex')}`,
      name: `Browser ${state.seq}`,
      private: false,
      askBeforeFinalActions: true,
      pairedAt: new Date(this.now()).toISOString()
    };
    return state.browsers[digest];
  }

  #public(state, digest) {
    const browser = state.browsers[digest];
    return browser ? { ...browser, private: browser.private === true, askBeforeFinalActions: browser.private === true || browser.askBeforeFinalActions !== false, shareDelegatedRuns: browser.private !== true, isDefault: state.defaultDigest === digest } : null;
  }

  #digestFor(state, publicId) {
    if (!PUBLIC_ID.test(String(publicId || ''))) return null;
    return Object.keys(state.browsers).find((digest) => state.browsers[digest].id === publicId) || null;
  }

  ensure(digest) {
    if (!DIGEST.test(String(digest || ''))) throw new TypeError('browser digest is invalid');
    const state = this.#read();
    if (!state.browsers[digest]) {
      this.#add(state, digest);
      if (!state.defaultDigest) state.defaultDigest = digest;
      this.#write(state);
    } else if (!existsSync(this.filePath)) {
      this.#write(state);
    }
    return this.#public(state, digest);
  }

  replaceToken(publicId, newDigest) {
    if (!DIGEST.test(String(newDigest || ''))) throw new TypeError('browser digest is invalid');
    const state = this.#read();
    const oldDigest = this.#digestFor(state, publicId);
    if (!oldDigest || state.browsers[newDigest]) throw new Error('browser not found or new token already paired');
    state.browsers[newDigest] = state.browsers[oldDigest];
    delete state.browsers[oldDigest];
    if (state.defaultDigest === oldDigest) state.defaultDigest = newDigest;
    this.#write(state);
    return { oldDigest, browser: this.#public(state, newDigest) };
  }

  byId(publicId) {
    return this.#digestFor(this.#read(), publicId);
  }

  byDigest(digest) {
    return this.#public(this.#read(), digest);
  }

  list() {
    const state = this.#read();
    return Object.keys(state.browsers).map((digest) => this.#public(state, digest));
  }

  defaultDigest() {
    const state = this.#read();
    return state.defaultDigest && state.browsers[state.defaultDigest] ? state.defaultDigest : null;
  }

  setDefault(publicId) {
    const state = this.#read();
    const digest = this.#digestFor(state, publicId);
    if (!digest) throw new Error('browser not found');
    state.defaultDigest = digest;
    this.#write(state);
    return this.#public(state, digest);
  }

  setPrivate(publicId, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Privacy must be true or false');
    const state = this.#read();
    const digest = this.#digestFor(state, publicId);
    if (!digest) throw new Error('browser not found');
    state.browsers[digest].private = enabled;
    if (enabled) state.browsers[digest].askBeforeFinalActions = true;
    delete state.browsers[digest].shareDelegatedRuns;
    this.#write(state);
    return this.#public(state, digest);
  }

  setAskBeforeFinalActions(publicId, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Final-action approval setting must be true or false');
    const state = this.#read();
    const digest = this.#digestFor(state, publicId);
    if (!digest) throw new Error('browser not found');
    if (state.browsers[digest].private === true && !enabled) throw new Error('Private browsers must ask before final actions');
    state.browsers[digest].askBeforeFinalActions = enabled;
    this.#write(state);
    return this.#public(state, digest);
  }

  setDelegatedRunSharing(publicId, enabled) {
    return this.setPrivate(publicId, !enabled);
  }

  rename(publicId, name) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 60 || /[\r\n<>]/.test(clean)) throw new Error('browser name must be 1-60 plain characters');
    const state = this.#read();
    const digest = this.#digestFor(state, publicId);
    if (!digest) throw new Error('browser not found');
    state.browsers[digest].name = clean;
    this.#write(state);
    return this.#public(state, digest);
  }

  remove(publicId) {
    const state = this.#read();
    const digest = this.#digestFor(state, publicId);
    if (!digest) return false;
    delete state.browsers[digest];
    if (state.defaultDigest === digest) state.defaultDigest = null;
    this.#write(state);
    return true;
  }
}
