import { BrowserRegistry, registryPaths } from '../broker/src/browser-registry.js';
import { PairedTokenStore } from '../broker/src/server.js';
import { existsSync, readFileSync } from 'node:fs';

function usage() {
  return [
    'Usage:',
    '  npm run browser -- [--env-file <path>] list',
    '  npm run browser -- [--env-file <path>] default <brw_id>',
    '  npm run browser -- [--env-file <path>] rename <brw_id> <name>',
    '  npm run browser -- [--env-file <path>] remove <brw_id>'
  ].join('\n');
}

function configuredEnv(args) {
  const env = { ...process.env };
  const index = args.indexOf('--env-file');
  if (index !== -1) {
    const path = args[index + 1];
    if (!path || path.startsWith('--')) throw new Error('--env-file requires a path');
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (!match) { if (line.trim() && !line.trim().startsWith('#')) throw new Error('Invalid env-file line.'); continue; }
      const value = match[2].trim();
      env[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
    }
    args.splice(index, 2);
  }
  for (const key of ['WORK_EDGE_TOKEN_STORE', 'WORK_EDGE_BROWSER_REGISTRY']) {
    if (!env[key]?.trim()) throw new Error(`${key} must be set explicitly (or supplied with --env-file).`);
  }
  return env;
}

function inFlightReport(env, digest) {
  if (!env.WORK_EDGE_COMMAND_STATE?.trim() || !existsSync(env.WORK_EDGE_COMMAND_STATE)) return 'unknown';
  const state = JSON.parse(readFileSync(env.WORK_EDGE_COMMAND_STATE, 'utf8'));
  if (!Array.isArray(state.records)) throw new Error('Command state store is unreadable.');
  return state.records.filter((record) => record.browserId === digest && record.state === 'received').length;
}

try {
  const args = process.argv.slice(2);
  const env = configuredEnv(args);
  const registry = new BrowserRegistry(registryPaths(env));
  const tokenStore = new PairedTokenStore({ filePath: env.WORK_EDGE_TOKEN_STORE });
  const [command, publicId, ...rest] = args;
  let result;
  if (command === 'list') {
    result = { browsers: registry.list(), defaultBrowserId: registry.byDigest(registry.defaultDigest())?.id || null };
  } else if (command === 'default' && publicId) {
    result = registry.setDefault(publicId);
  } else if (command === 'rename' && publicId && rest.length) {
    result = registry.rename(publicId, rest.join(' '));
  } else if (command === 'remove' && publicId) {
    const digest = registry.byId(publicId);
    if (!digest) throw new Error('browser not found');
    const revokedInFlight = inFlightReport(env, digest);
    const revoked = tokenStore.revoke(digest);
    if (!registry.remove(publicId)) throw new Error('browser not found');
    result = { removed: true, revoked, ...(revoked ? {} : { alreadyRevoked: true }), id: publicId, revokedInFlight };
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
  if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
