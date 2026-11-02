import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SECRET_ENV = {
  ownerMcpToken: 'WORK_EDGE_MCP_TOKEN',
  pairingAdminToken: 'WORK_EDGE_DEV_TOKEN',
  transactionKey: 'FBB_TRANSACTION_SECRET',
  handoffSecret: 'WORK_EDGE_HANDOFF_AUTH_SECRET',
  oauthPassphrase: 'FBB_LOGIN_PASSPHRASE',
  ownerPassphrase: 'FBB_OWNER_PASSPHRASE'
};

function generateSecrets() {
  return {
    ownerMcpToken: randomBytes(32).toString('base64url'),
    pairingAdminToken: randomBytes(32).toString('base64url'),
    transactionKey: randomBytes(32).toString('base64'),
    handoffSecret: randomBytes(32).toString('base64url'),
    oauthPassphrase: randomBytes(32).toString('base64url'),
    ownerPassphrase: randomBytes(32).toString('base64url')
  };
}

function readSecrets(filePath) {
  if (!existsSync(filePath)) return null;
  let value;
  try { value = JSON.parse(readFileSync(filePath, 'utf8')); } catch (error) { throw new Error(`First-boot secrets are unreadable: ${error.message}`); }
  for (const key of Object.keys(SECRET_ENV)) {
    if (key === 'ownerPassphrase' && value?.[key] === undefined) continue;
    if (typeof value?.[key] !== 'string' || !value[key]) throw new Error(`First-boot secrets are invalid: ${key} is missing.`);
  }
  return value;
}

function writeSecrets(filePath, secrets) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(secrets, null, 2), { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}

export function firstBootSecretsFile(env = process.env) {
  return join(resolve(env.FBB_DATA_DIR || '/data'), 'secrets.json');
}

export function ensureFirstBoot({ env = process.env } = {}) {
  const filePath = firstBootSecretsFile(env);
  let secrets = readSecrets(filePath);
  if (!secrets) {
    secrets = generateSecrets();
    writeSecrets(filePath, secrets);
  } else if (!secrets.ownerPassphrase) {
    secrets = { ...secrets, ownerPassphrase: randomBytes(32).toString('base64url') };
    writeSecrets(filePath, secrets);
  }
  chmodSync(filePath, 0o600);
  for (const [key, envKey] of Object.entries(SECRET_ENV)) if (!env[envKey]) env[envKey] = secrets[key];
  return { env, secrets, filePath };
}

export function loadFirstBootSecrets(env = process.env) {
  const filePath = firstBootSecretsFile(env);
  const secrets = readSecrets(filePath);
  if (!secrets) throw new Error(`First-boot secrets do not exist at ${filePath}. Start the broker first.`);
  return secrets;
}
