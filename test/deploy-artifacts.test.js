import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('systemd confines writes to the Field Browser Bridge state directory', () => {
  const unit = read('../deploy/field-browser-bridge.service');
  assert.match(unit, /^User=root$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/field-browser-bridge$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/field-browser-bridge\/env$/m);
  for (const directive of ['StateDirectory=field-browser-bridge', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=true']) assert.match(unit, new RegExp(`^${directive}$`, 'm'));
});

test('deployment environment documents every broker variable and private state path', () => {
  const example = read('../deploy/env.example');
  const expected = [
    'FBB_LISTEN_HOST', 'FBB_LISTEN_PORT', 'PUBLIC_BASE_URL', 'FBB_LOGIN_PASSPHRASE', 'FBB_OWNER_PASSPHRASE',
    'FBB_OAUTH_STATE', 'FBB_OAUTH_CAPABILITIES', 'WORK_EDGE_DEV_TOKEN', 'WORK_EDGE_MCP_TOKEN',
    'WORK_EDGE_MCP_ID', 'WORK_EDGE_AUTO_PROVISION_CAPABILITIES', 'WORK_EDGE_POLICY',
    'WORK_EDGE_TOKEN_STORE', 'WORK_EDGE_AGENT_TOKEN_STORE', 'WORK_EDGE_COMMAND_STATE',
    'WORK_EDGE_RECEIPT_STORE', 'WORK_EDGE_TRANSACTION_STORE', 'WORK_EDGE_TRANSACTION_KEY',
    'WORK_EDGE_HANDOFF_AUTH_SECRET'
  ];
  for (const name of expected) assert.match(example, new RegExp(`^${name}=`, 'm'), name);
  assert.match(example, /^FBB_LISTEN_HOST=172\.18\.0\.1$/m);
  assert.match(example, /^FBB_LISTEN_PORT=8767$/m);
  assert.match(example, /# Owner administration uses a separate passphrase from OAuth web-app sign-in\.\nFBB_OWNER_PASSPHRASE=/);
  for (const line of example.split('\n').filter((value) => /_(?:STATE|STORE|KEY)=/.test(value) && value.includes('/'))) assert.match(line, /=\/var\/lib\/field-browser-bridge\//);
});

test('Caddy proxies the complete host and README covers pairing, clients, and safety', () => {
  const caddy = read('../deploy/Caddyfile.snippet');
  assert.match(caddy, /^bridge\.example\.com \{/m);
  assert.match(caddy, /reverse_proxy 172\.18\.0\.1:8767/);
  assert.doesNotMatch(caddy, /handle_path|\/mcp\*/);
  const readme = read('../README.md');
  for (const required of ['Load unpacked', 'npm run pair-code', 'Claude.ai', 'ChatGPT', 'Claude Code', 'Codex', 'Safety model']) assert.match(readme, new RegExp(required.replace('.', '\\.')));
});
