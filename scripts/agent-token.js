import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { AGENT_CAPABILITIES } from '../broker/src/agent-capabilities.js';
import { statePaths } from '../broker/src/server.js';

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
    '  npm run agent-token -- create --id claude-code --cap browser.read,browser.control',
    '  npm run agent-token -- list',
    '  npm run agent-token -- revoke --id claude-code',
    '',
    `Capabilities: ${AGENT_CAPABILITIES.join(', ')}`,
  ].join('\n');
}

const [command, ...args] = process.argv.slice(2);
const store = new AgentTokenStore({ filePath: statePaths(process.env).agentTokens });

try {
  if (command === 'create') {
    const created = store.create({ id: value(args, '--id'), capabilities: values(args, '--cap') });
    process.stdout.write(`${JSON.stringify({ ...created, warning: 'Copy this token now. It is stored only as a hash and cannot be displayed again.' }, null, 2)}\n`);
  } else if (command === 'list') {
    process.stdout.write(`${JSON.stringify(store.list(), null, 2)}\n`);
  } else if (command === 'revoke') {
    const id = value(args, '--id');
    if (!store.revoke(id)) throw new Error(`Active agent was not found: ${id}`);
    process.stdout.write(`${JSON.stringify({ revoked: true, id })}\n`);
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
