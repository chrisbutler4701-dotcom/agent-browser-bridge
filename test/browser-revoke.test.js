import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { PairedTokenStore } from '../broker/src/server.js';

test('revoke removes only the selected hash with an atomic private file write', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-revoke-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'tokens.json');
  const store = new PairedTokenStore({ filePath });
  const first = 'first-browser-token';
  const second = 'second-browser-token';
  const digest = createHash('sha256').update(first).digest('hex');
  store.add(first);
  store.add(second);
  assert.equal(store.revoke(digest), true);
  assert.equal(store.matches(first), false);
  assert.equal(store.matches(second), true);
  assert.equal(store.revoke(digest), false);
  assert.deepEqual(store.read().tokenHashes, [createHash('sha256').update(second).digest('hex')]);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(readFileSync(filePath, 'utf8').includes(first), false);
});

test('browser remove revokes the token and removes the public registry entry', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-revoke-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'tokens.json');
  const registryPath = join(directory, 'registry.json');
  const token = 'cli-browser-token';
  const digest = createHash('sha256').update(token).digest('hex');
  const store = new PairedTokenStore({ filePath });
  const registry = new BrowserRegistry({ filePath: registryPath });
  store.add(token);
  const browser = registry.ensure(digest);
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/browser.js', 'remove', browser.id], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, WORK_EDGE_TOKEN_STORE: filePath, WORK_EDGE_BROWSER_REGISTRY: registryPath },
    encoding: 'utf8'
  }));
  assert.deepEqual(result, { removed: true, revoked: true, id: browser.id, revokedInFlight: 'unknown' });
  assert.equal(store.matches(token), false);
  assert.equal(registry.byId(browser.id), null);
});

test('browser remove finishes a prior token revocation and clears the default selection', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-revoke-retry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'tokens.json');
  const registryPath = join(directory, 'registry.json');
  const token = 'retry-browser-token';
  const digest = createHash('sha256').update(token).digest('hex');
  const store = new PairedTokenStore({ filePath });
  const registry = new BrowserRegistry({ filePath: registryPath });
  store.add(token);
  const browser = registry.ensure(digest);
  assert.equal(registry.defaultDigest(), digest);
  assert.equal(store.revoke(digest), true);
  const args = ['scripts/browser.js', 'remove', browser.id];
  const options = {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, WORK_EDGE_TOKEN_STORE: filePath, WORK_EDGE_BROWSER_REGISTRY: registryPath },
    encoding: 'utf8'
  };
  const result = JSON.parse(execFileSync(process.execPath, args, options));
  assert.deepEqual(result, { removed: true, revoked: false, alreadyRevoked: true, id: browser.id, revokedInFlight: 'unknown' });
  assert.equal(registry.byId(browser.id), null);
  assert.equal(registry.defaultDigest(), null);
  const missing = spawnSync(process.execPath, args, options);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /browser not found/);
});

test('browser CLI refuses missing explicit store paths instead of using legacy defaults', () => {
  const result = spawnSync(process.execPath, ['scripts/browser.js', 'list'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH }, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WORK_EDGE_TOKEN_STORE must be set explicitly/);
  assert.equal(result.stdout, '');
  const missingRegistry = spawnSync(process.execPath, ['scripts/browser.js', 'list'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, WORK_EDGE_TOKEN_STORE: '/tmp/unused-browser-tokens.json' }, encoding: 'utf8'
  });
  assert.equal(missingRegistry.status, 1);
  assert.match(missingRegistry.stderr, /WORK_EDGE_BROWSER_REGISTRY must be set explicitly/);
});

test('browser CLI loads deployed paths from env-file and reports received commands as uncertain', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-revoke-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'tokens.json');
  const registryPath = join(directory, 'registry.json');
  const commandPath = join(directory, 'commands.json');
  const envPath = join(directory, 'env');
  const token = 'env-file-browser-token';
  const digest = createHash('sha256').update(token).digest('hex');
  const store = new PairedTokenStore({ filePath: tokenPath });
  const registry = new BrowserRegistry({ filePath: registryPath });
  store.add(token);
  const browser = registry.ensure(digest);
  writeFileSync(commandPath, JSON.stringify({ records: [{ browserId: digest, state: 'received' }] }));
  writeFileSync(envPath, `WORK_EDGE_TOKEN_STORE="${tokenPath}"\nWORK_EDGE_BROWSER_REGISTRY='${registryPath}'\nWORK_EDGE_COMMAND_STATE=${commandPath}\n`);
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/browser.js', '--env-file', envPath, 'remove', browser.id], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8'
  }));
  assert.deepEqual(result, { removed: true, revoked: true, id: browser.id, revokedInFlight: 1 });
  assert.equal(store.matches(token), false);
  assert.equal(registry.byId(browser.id), null);
});
