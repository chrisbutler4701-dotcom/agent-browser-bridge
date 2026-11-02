import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureFirstBoot } from '../broker/src/first-boot.js';

test('fresh first boot writes a separate private owner passphrase once, reuses it, and prints nothing', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fbb-first-boot-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const firstEnv = { FBB_DATA_DIR: dataDir };
  const first = ensureFirstBoot({ env: firstEnv });
  const secretsFile = join(dataDir, 'secrets.json');
  const saved = JSON.parse(readFileSync(secretsFile, 'utf8'));
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.deepEqual(first.secrets, saved);
  assert.equal(firstEnv.WORK_EDGE_MCP_TOKEN, saved.ownerMcpToken);
  assert.equal(firstEnv.WORK_EDGE_DEV_TOKEN, saved.pairingAdminToken);
  assert.equal(firstEnv.FBB_TRANSACTION_SECRET, saved.transactionKey);
  assert.equal(firstEnv.WORK_EDGE_HANDOFF_AUTH_SECRET, saved.handoffSecret);
  assert.equal(firstEnv.FBB_LOGIN_PASSPHRASE, saved.oauthPassphrase);
  assert.equal(firstEnv.FBB_OWNER_PASSPHRASE, saved.ownerPassphrase);
  assert.equal(Buffer.from(saved.ownerPassphrase, 'base64url').length, 32);
  assert.notEqual(saved.ownerPassphrase, saved.oauthPassphrase);
  const moduleUrl = new URL('../broker/src/first-boot.js', import.meta.url).href;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `import { ensureFirstBoot } from ${JSON.stringify(moduleUrl)}; ensureFirstBoot();`], { encoding: 'utf8', env: { ...process.env, FBB_DATA_DIR: dataDir } });
  assert.equal(stdout, '');

  chmodSync(secretsFile, 0o644);
  const secondEnv = { FBB_DATA_DIR: dataDir };
  const second = ensureFirstBoot({ env: secondEnv });
  assert.deepEqual(second.secrets, first.secrets);
  assert.deepEqual(JSON.parse(readFileSync(secretsFile, 'utf8')), saved);
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
});

test('first boot upgrades an old secrets file atomically without changing existing values', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fbb-first-boot-upgrade-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const secretsFile = join(dataDir, 'secrets.json');
  const oldSecrets = {
    ownerMcpToken: 'old-owner-mcp-value',
    pairingAdminToken: 'old-pairing-value',
    transactionKey: 'old-transaction-value',
    handoffSecret: 'old-handoff-value',
    oauthPassphrase: 'old-oauth-value',
    futureCompatibleValue: 'preserve-this-exact-value'
  };
  writeFileSync(secretsFile, JSON.stringify(oldSecrets, null, 4), { mode: 0o600 });

  const upgraded = ensureFirstBoot({ env: { FBB_DATA_DIR: dataDir } });
  const saved = JSON.parse(readFileSync(secretsFile, 'utf8'));
  for (const [key, value] of Object.entries(oldSecrets)) assert.equal(saved[key], value, key);
  assert.equal(Buffer.from(saved.ownerPassphrase, 'base64url').length, 32);
  assert.equal(upgraded.env.FBB_OWNER_PASSPHRASE, saved.ownerPassphrase);
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dataDir), ['secrets.json']);
});

test('owner-passphrase script prints the explicit environment value or first-boot owner passphrase', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fbb-owner-passphrase-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { secrets } = ensureFirstBoot({ env: { FBB_DATA_DIR: dataDir } });
  const script = fileURLToPath(new URL('../scripts/owner-passphrase.js', import.meta.url));
  const fromEnvironment = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, FBB_DATA_DIR: dataDir, FBB_OWNER_PASSPHRASE: 'explicit-owner-passphrase' }
  });
  assert.equal(fromEnvironment, 'explicit-owner-passphrase\n');
  const fromFirstBoot = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, FBB_DATA_DIR: dataDir, FBB_OWNER_PASSPHRASE: '' }
  });
  assert.equal(fromFirstBoot, `${secrets.ownerPassphrase}\n`);
});
