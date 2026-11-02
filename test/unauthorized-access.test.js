import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { invoke } from './http-harness.js';

const policy = { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: true, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } };
const READ_TOOLS = ['edge_status', 'edge_bridge_status', 'edge_active_tab', 'edge_list_tabs', 'edge_snapshot', 'edge_extract_text', 'edge_screenshot'];

test('no credential, a wrong credential, or a browser pairing token gets no browser data', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-unauth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add('b'.repeat(32));
  const agents = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  const reader = agents.create({ id: 'reader', capabilities: ['browser.read'] }).token;
  const server = createServer({ policy, devToken: 'pairing-only-key-0123456789abcdef', tokenStore, agentTokenStore: agents, env: { WORK_EDGE_MCP_TOKEN: 'owner-token-0123456789abcdef0123' } });
  t.after(() => server.close());
  const call = (token, name) => invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) });
  for (const name of READ_TOOLS) {
    for (const token of [null, 'x'.repeat(40), 'b'.repeat(32), 'pairing-only-key-0123456789abcdef']) {
      assert.equal((await call(token, name)).status, 401, `${name} with ${token ? 'bad token' : 'no token'}`);
    }
  }
  const denied = JSON.parse((await call(reader, 'edge_click')).body);
  assert.equal(denied.error.code, -32003, 'read-only agent cannot control');
});
