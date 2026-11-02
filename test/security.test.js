import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['https://approved.example'],
  denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: true, retentionSeconds: 300 },
  audit: { enabled: false, includeUrlPath: false }
};

test('unauthenticated broker routes never expose captured browser data', async () => {
  const server = createServer({ policy, env: { PUBLIC_BASE_URL: 'https://bridge.example.com' } });
  const capture = JSON.stringify({
    tabId: 7, title: 'Synthetic private page', url: 'https://approved.example/private',
    text: 'SYNTHETIC_PRIVATE_PAGE_TEXT', elementSummary: [{ tag: 'button', text: 'Synthetic action' }],
    userInitiated: true, capturedAt: new Date().toISOString()
  });
  const ingest = await invoke(server, { method: 'POST', url: '/work-edge/ingest', headers: { 'content-type': 'application/json' }, body: capture });
  assert.ok([401, 503].includes(ingest.status));
  const mcp = await invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edge_snapshot', arguments: {} } }) });
  assert.equal(mcp.status, 401);
  assert.doesNotMatch(mcp.body, /SYNTHETIC_PRIVATE_PAGE_TEXT|Synthetic private page|Synthetic action/);
  assert.equal(mcp.headers['www-authenticate'], 'Bearer resource_metadata="https://bridge.example.com/.well-known/oauth-protected-resource/mcp"');
  server.close();
});

test('authenticated and OAuth responses never emit wildcard CORS', async () => {
  const server = createServer({ policy, devToken: 'synthetic-owner-token', env: { PUBLIC_BASE_URL: 'https://bridge.example.com', WORK_EDGE_MCP_TOKEN: 'synthetic-owner-token' } });
  const responses = [
    await invoke(server, { url: '/.well-known/oauth-authorization-server' }),
    await invoke(server, { method: 'GET', url: '/login?req=missing' }),
    await invoke(server, { method: 'POST', url: '/mcp', headers: { authorization: 'Bearer synthetic-owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
  ];
  for (const response of responses) assert.notEqual(response.headers['access-control-allow-origin'], '*');
  server.close();
});

test('every OAuth POST endpoint rejects bodies larger than 64 KB', async () => {
  const server = createServer({ policy, env: { PUBLIC_BASE_URL: 'https://bridge.example.com' } });
  for (const url of ['/register', '/login', '/token', '/revoke']) {
    const response = await invoke(server, { method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `value=${'x'.repeat(65_537)}` });
    assert.equal(response.status, 413, url);
  }
  server.close();
});

test('the browser pairing key does not authenticate MCP', async (t) => {
  const server = createServer({ policy: { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } }, devToken: 'pairing-only-key-0123456789abcdef', env: {} });
  t.after(() => server.close());
  const response = await invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer pairing-only-key-0123456789abcdef' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(response.status, 401);
});
