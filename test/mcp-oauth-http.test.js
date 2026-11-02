import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { OAuthProvider } from '../broker/src/oauth.js';
import { createServer } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const publicBaseUrl = 'https://bridge.example.com';
const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includeUrlPath: false }
};
const jsonHeaders = { 'content-type': 'application/json' };
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
const json = (response) => response.body ? JSON.parse(response.body) : null;
const bearer = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });

test('MCP lifecycle negotiates initialize, accepts notification, lists titled tools, and calls a tool', async () => {
  const server = createServer({ policy, devToken: 'synthetic-owner-token', env: { PUBLIC_BASE_URL: publicBaseUrl, WORK_EDGE_MCP_TOKEN: 'synthetic-owner-token' } });
  const initialize = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer('synthetic-owner-token'), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
  assert.equal(initialize.status, 200);
  assert.equal(json(initialize).result.protocolVersion, '2025-06-18');
  assert.deepEqual(json(initialize).result.capabilities, { tools: { listChanged: false } });
  assert.match(json(initialize).result.instructions, /paired browser/i);

  const initialized = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer('synthetic-owner-token'), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(initialized.status, 202);
  assert.equal(initialized.body, '');
  const responseMessage = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer('synthetic-owner-token'), body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
  assert.equal(responseMessage.status, 202);

  const listed = await invoke(server, { method: 'POST', url: '/work-edge/mcp', headers: bearer('synthetic-owner-token'), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(listed.status, 200);
  assert.ok(json(listed).result.tools.length > 0);
  for (const tool of json(listed).result.tools) assert.equal(typeof tool.annotations.title, 'string');
  const called = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer('synthetic-owner-token'), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edge_status', arguments: {} } }) });
  assert.equal(called.status, 200);
  assert.equal(json(called).result.content[0].type, 'text');
  server.close();
});

test('MCP GET is 405 and unauthenticated POST includes OAuth resource metadata challenge', async () => {
  const server = createServer({ policy, env: { PUBLIC_BASE_URL: publicBaseUrl } });
  const get = await invoke(server, { method: 'GET', url: '/mcp' });
  assert.equal(get.status, 405);
  const denied = await invoke(server, { method: 'POST', url: '/mcp', headers: jsonHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['www-authenticate'], `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
  server.close();
});

test('full HTTP OAuth flow authenticates MCP, rejects code reuse, rotates refresh, and survives a new process', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-http-oauth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'oauth.json');
  const oauth = new OAuthProvider({ publicBaseUrl, passphrase: 'synthetic-passphrase', stateFile, delay: async () => {} });
  const server = createServer({ policy, oauthProvider: oauth, env: { PUBLIC_BASE_URL: publicBaseUrl } });
  const registered = await invoke(server, { method: 'POST', url: '/register', headers: jsonHeaders, body: JSON.stringify({ client_name: 'Synthetic Web App', redirect_uris: ['https://app.example.test/callback'], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'] }) });
  assert.equal(registered.status, 201);
  const client = json(registered);
  const verifier = 'synthetic-pkce-verifier-value-12345678901234567890';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/authorize', publicBaseUrl);
  for (const [key, value] of Object.entries({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state: 'synthetic-state' })) authorize.searchParams.set(key, value);
  const parked = await invoke(server, { url: `${authorize.pathname}${authorize.search}` });
  assert.equal(parked.status, 302);
  const requestId = new URL(parked.headers.location).searchParams.get('req');
  const loginPage = await invoke(server, { url: `/login?req=${encodeURIComponent(requestId)}` });
  assert.match(loginPage.body, /Synthetic Web App/);
  const wrong = await invoke(server, { method: 'POST', url: '/login', headers: formHeaders, body: new URLSearchParams({ req: requestId, passphrase: 'wrong' }).toString() });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /role="alert"/);
  const accepted = await invoke(server, { method: 'POST', url: '/login', headers: formHeaders, body: new URLSearchParams({ req: requestId, passphrase: 'synthetic-passphrase' }).toString() });
  assert.equal(accepted.status, 302);
  const callback = new URL(accepted.headers.location);
  assert.equal(callback.searchParams.get('state'), 'synthetic-state');
  const code = callback.searchParams.get('code');
  const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: client.redirect_uris[0], client_id: client.client_id, client_secret: client.client_secret }).toString();
  const exchanged = await invoke(server, { method: 'POST', url: '/token', headers: formHeaders, body: tokenBody });
  assert.equal(exchanged.status, 200);
  const tokens = json(exchanged);
  const oauthCall = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer(tokens.access_token), body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'edge_status', arguments: {} } }) });
  assert.equal(oauthCall.status, 200);
  const reused = await invoke(server, { method: 'POST', url: '/token', headers: formHeaders, body: tokenBody });
  assert.equal(reused.status, 400);
  assert.equal(json(reused).error, 'invalid_grant');
  const refreshed = await invoke(server, { method: 'POST', url: '/token', headers: formHeaders, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: client.client_secret }).toString() });
  assert.equal(refreshed.status, 200);
  assert.notEqual(json(refreshed).refresh_token, tokens.refresh_token);

  const script = `import { OAuthProvider } from ${JSON.stringify(new URL('../broker/src/oauth.js', import.meta.url).href)}; const principal = new OAuthProvider({ stateFile: process.env.FBB_TEST_STATE, publicBaseUrl: ${JSON.stringify(publicBaseUrl)} }).authenticate(process.env.FBB_TEST_TOKEN); process.stdout.write(principal?.id || '');`;
  const restoredId = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, FBB_TEST_STATE: stateFile, FBB_TEST_TOKEN: tokens.access_token } });
  assert.equal(restoredId, `oauth:${client.client_id}`);
  server.close();
});

test('existing scoped agent tokens still authenticate MCP after OAuth is enabled', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-agent-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new AgentTokenStore({ filePath: join(directory, 'agents.json') });
  const token = 'a'.repeat(43);
  store.add(token, { id: 'synthetic-agent', capabilities: ['browser.read'] });
  const oauth = new OAuthProvider({ publicBaseUrl, stateFile: join(directory, 'oauth.json') });
  const server = createServer({ policy, agentTokenStore: store, oauthProvider: oauth, env: { PUBLIC_BASE_URL: publicBaseUrl } });
  const listed = await invoke(server, { method: 'POST', url: '/mcp', headers: bearer(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(listed.status, 200);
  assert.ok(json(listed).result.tools.every((tool) => tool.annotations.readOnlyHint === true));
  server.close();
});
