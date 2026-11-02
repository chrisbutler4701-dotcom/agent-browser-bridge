import { OAuthProvider } from '../broker/src/oauth.js';
import { AGENT_CAPABILITIES } from '../broker/src/agent-capabilities.js';

function values(args, flag) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) found.push(...args[index + 1].split(',').filter(Boolean));
  }
  return found;
}

function value(args, flag) {
  return values(args, flag)[0];
}

function usage() {
  return [
    'Usage:',
    '  npm run oauth-client -- list',
    '  npm run oauth-client -- grant --client <id> --cap browser.read,browser.control',
    '  npm run oauth-client -- revoke --client <id>',
    '',
    `Capabilities: ${AGENT_CAPABILITIES.join(', ')}`,
  ].join('\n');
}

const [command, ...args] = process.argv.slice(2);
const provider = new OAuthProvider({
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  passphrase: process.env.FBB_LOGIN_PASSPHRASE,
  stateFile: process.env.FBB_OAUTH_STATE,
  capabilities: process.env.FBB_OAUTH_CAPABILITIES,
});

try {
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(provider.listClients(), null, 2)}\n`);
  } else if (command === 'grant') {
    process.stdout.write(`${JSON.stringify(provider.grantClient(value(args, '--client'), values(args, '--cap')), null, 2)}\n`);
  } else if (command === 'revoke') {
    const clientId = value(args, '--client');
    if (!provider.revokeClient(clientId)) throw new Error(`OAuth client was not found: ${clientId}`);
    process.stdout.write(`${JSON.stringify({ revoked: true, clientId })}\n`);
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
