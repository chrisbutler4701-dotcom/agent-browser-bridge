import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { OAuthProvider } from '../broker/src/oauth.js';
import { OwnerSessions } from '../broker/src/owner-session.js';
import { createServer } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const publicBaseUrl = 'https://browser.example.test';
const ownerPassphrase = 'owner correct horse';
const loginPassphrase = 'web app correct horse';
const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includeUrlPath: false }
};
const jsonHeaders = { 'content-type': 'application/json' };
const json = (response) => response.body ? JSON.parse(response.body) : null;
const bearer = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });
const body = (value) => JSON.stringify(value);

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-owner-routes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const auditLines = [];
  const configuredOwnerPassphrase = Object.hasOwn(options, 'configuredOwnerPassphrase') ? options.configuredOwnerPassphrase : ownerPassphrase;
  const configuredLoginPassphrase = Object.hasOwn(options, 'configuredLoginPassphrase') ? options.configuredLoginPassphrase : loginPassphrase;
  const env = {
    PUBLIC_BASE_URL: publicBaseUrl,
    FBB_DATA_DIR: directory,
    FBB_TRUSTED_PROXIES: 'unknown'
  };
  if (configuredOwnerPassphrase !== undefined) env.FBB_OWNER_PASSPHRASE = configuredOwnerPassphrase;
  if (configuredLoginPassphrase !== undefined) env.FBB_LOGIN_PASSPHRASE = configuredLoginPassphrase;
  const oauth = new OAuthProvider({
    publicBaseUrl,
    passphrase: configuredLoginPassphrase,
    stateFile: join(directory, 'oauth.json'),
    now: () => now,
    delay: async () => {}
  });
  const ownerSessions = new OwnerSessions({
    passphrase: configuredOwnerPassphrase,
    loginPassphrase: configuredLoginPassphrase,
    now: () => now,
    delay: async () => {}
  });
  const agentTokenStore = new AgentTokenStore({ filePath: join(directory, 'agents.json'), clock: () => new Date(now) });
  const commandQueue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json'), now: () => now });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const server = createServer({
    policy,
    env,
    oauthProvider: oauth,
    ownerSessions,
    agentTokenStore,
    commandQueue,
    browserRegistry,
    auditWriter: (line) => auditLines.push(line)
  });
  t.after(() => server.close());
  return { server, oauth, ownerSessions, agentTokenStore, commandQueue, browserRegistry, auditLines, advance(ms) { now += ms; } };
}

function serverFromEnv(t, { owner = ownerPassphrase, login = loginPassphrase } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-owner-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PUBLIC_BASE_URL: publicBaseUrl, FBB_DATA_DIR: directory };
  if (owner !== undefined) env.FBB_OWNER_PASSPHRASE = owner;
  if (login !== undefined) env.FBB_LOGIN_PASSPHRASE = login;
  const server = createServer({ policy, env });
  t.after(() => server.close());
  return server;
}

async function signIn(server, suppliedPassphrase = ownerPassphrase, ip = '198.51.100.10') {
  return invoke(server, {
    method: 'POST', url: '/work-edge/owner/session',
    headers: { ...jsonHeaders, 'x-forwarded-for': ip },
    body: body({ passphrase: suppliedPassphrase })
  });
}

async function issueOAuthToken(oauth) {
  const registration = oauth.register({
    client_name: 'Claude.ai',
    redirect_uris: ['https://claude.example.test/callback'],
    token_endpoint_auth_method: 'none'
  });
  const verifier = 'owner-route-pkce-verifier-123456789012345678901234';
  const authorize = oauth.authorize({
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  });
  const requestId = new URL(authorize).searchParams.get('req');
  const login = await oauth.login({ requestId, passphrase: loginPassphrase, ip: '203.0.113.40' });
  const code = new URL(login.location).searchParams.get('code');
  const issued = oauth.exchange({
    grant_type: 'authorization_code', client_id: registration.client_id,
    code, redirect_uri: registration.redirect_uris[0], code_verifier: verifier
  });
  return { registration, issued };
}

test('owner sign-in delays wrong passphrases, locks the sixth try by IP, and allows a fresh IP', async (t) => {
  const { server, ownerSessions } = fixture(t);
  const wrong = await signIn(server, 'wrong');
  assert.equal(wrong.status, 401);
  assert.deepEqual(json(wrong), { error: 'That passphrase did not match. Try again.' });
  for (let attempt = 1; attempt < 5; attempt += 1) assert.equal((await signIn(server, 'wrong')).status, 401);
  const locked = await signIn(server, ownerPassphrase);
  assert.equal(locked.status, 429);
  assert.deepEqual(json(locked), { error: 'Too many wrong tries. Wait 15 minutes, then try again.' });
  const accepted = await ownerSessions.signIn({ passphrase: ownerPassphrase, ip: '198.51.100.11' });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.token.length >= 43);
  assert.equal(typeof accepted.expiresAt, 'string');
});

test('owner agent list requires a live session and returns the public MCP URL', async (t) => {
  const { server } = fixture(t);
  const denied = await invoke(server, { url: '/work-edge/owner/agents' });
  assert.equal(denied.status, 401);
  assert.deepEqual(json(denied), { error: 'Sign in again with your owner passphrase.' });
  const session = json(await signIn(server)).token;
  const listed = await invoke(server, { url: '/work-edge/owner/agents', headers: bearer(session) });
  assert.equal(listed.status, 200);
  assert.equal(json(listed).mcpUrl, `${publicBaseUrl}/mcp`);
  assert.deepEqual(json(listed).agents, []);
});

test('owner creates uniquely named Claude Code agents and revocation immediately refuses MCP', async (t) => {
  const { server } = fixture(t);
  const session = json(await signIn(server)).token;
  const created = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents', headers: bearer(session), body: body({ preset: 'claude-code' })
  });
  assert.equal(created.status, 201);
  assert.equal(json(created).id, 'claude-code');
  assert.deepEqual(json(created).capabilities, ['browser.control', 'browser.read']);
  assert.match(json(created).setup.text, /claude mcp add/);
  assert.ok(json(created).setup.text.includes(json(created).token));
  const second = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents', headers: bearer(session), body: body({ preset: 'claude-code' })
  });
  assert.equal(second.status, 201);
  assert.equal(json(second).id, 'claude-code-2');

  const agentToken = json(created).token;
  const tools = await invoke(server, {
    method: 'POST', url: '/mcp', headers: bearer(agentToken),
    body: body({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(tools.status, 200);
  assert.ok(json(tools).result.tools.length > 0);
  const revoked = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents/revoke', headers: bearer(session), body: body({ id: 'claude-code' })
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(json(revoked), { revoked: true, cancelledCommands: 0 });
  const refused = await invoke(server, {
    method: 'POST', url: '/mcp', headers: bearer(agentToken),
    body: body({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.equal(refused.status, 401);
});

test('owner route audit records actions and never records credentials', async (t) => {
  const { server, auditLines } = fixture(t);
  const signedIn = await signIn(server);
  const session = json(signedIn).token;
  const created = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents', headers: bearer(session), body: body({ preset: 'codex' })
  });
  await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents/revoke', headers: bearer(session), body: body({ id: 'codex' })
  });
  const audit = auditLines.join('');
  assert.match(audit, /"tool":"owner_session"/);
  assert.match(audit, /"tool":"owner_agent_create"/);
  assert.match(audit, /"tool":"owner_agent_revoke"/);
  assert.equal(audit.includes(json(created).token), false);
  assert.equal(audit.includes(ownerPassphrase), false);
  const entries = auditLines.map((line) => JSON.parse(line));
  assert.ok(entries.every((entry) => Object.hasOwn(entry, 'target')));
  assert.ok(entries.some((entry) => entry.tool === 'owner_session' && entry.target === null));
  assert.ok(entries.some((entry) => entry.tool === 'owner_agent_create' && entry.target === 'codex'));
});

test('forged and expired sessions are refused on every protected owner route', async (t) => {
  const fixtureState = fixture(t);
  const session = json(await signIn(fixtureState.server)).token;
  fixtureState.advance(15 * 60_000 + 1);
  const routes = [
    { method: 'DELETE', url: '/work-edge/owner/session' },
    { method: 'GET', url: '/work-edge/owner/agents' },
    { method: 'POST', url: '/work-edge/owner/agents', body: body({ preset: 'codex' }) },
    { method: 'POST', url: '/work-edge/owner/agents/revoke', body: body({ id: 'codex' }) },
    { method: 'POST', url: '/work-edge/owner/web-apps/revoke', body: body({ clientId: 'missing' }) },
    { method: 'POST', url: '/work-edge/owner/pair', body: body({}) }
  ];
  for (const credential of [session, 'forged-session-token-that-is-long-enough-for-testing']) {
    for (const route of routes) {
      const response = await invoke(fixtureState.server, { ...route, headers: bearer(credential) });
      assert.equal(response.status, 401, `${route.method} ${route.url}`);
      assert.deepEqual(json(response), { error: 'Sign in again with your owner passphrase.' });
    }
  }
});

test('owner lists and revokes a web app so its next MCP call is refused', async (t) => {
  const { server, oauth } = fixture(t);
  const { registration, issued } = await issueOAuthToken(oauth);
  const session = json(await signIn(server)).token;
  const listed = await invoke(server, { url: '/work-edge/owner/agents', headers: bearer(session) });
  assert.deepEqual(json(listed).webApps, [{
    clientId: registration.client_id,
    displayName: 'Claude.ai',
    capabilities: ['browser.read'],
    activeTokens: 1
  }]);
  const revoked = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/web-apps/revoke', headers: bearer(session),
    body: body({ clientId: registration.client_id })
  });
  assert.equal(revoked.status, 200);
  const refused = await invoke(server, {
    method: 'POST', url: '/mcp', headers: bearer(issued.access_token),
    body: body({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  });
  assert.equal(refused.status, 401);
});

test('owner agent revoke cancels only that agent queued commands and reports the count', async (t) => {
  const state = fixture(t);
  const session = json(await signIn(state.server)).token;
  state.agentTokenStore.add('agent-a-token-that-is-at-least-32-characters', { id: 'agent-a', capabilities: ['browser.control'] });
  state.agentTokenStore.add('agent-b-token-that-is-at-least-32-characters', { id: 'agent-b', capabilities: ['browser.control'] });
  const commandA = { id: 'queued-a', type: 'wait', ms: 1, agentId: 'agent-a', createdAt: new Date().toISOString() };
  const commandB = { id: 'queued-b', type: 'wait', ms: 1, agentId: 'agent-b', createdAt: new Date().toISOString() };
  state.commandQueue.enqueue('browser-a', commandA, 5_000);
  state.commandQueue.enqueue('browser-b', commandB, 5_000);
  const caller = state.commandQueue.waitForResult('browser-a', commandA.id, 5_000);

  const revoked = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/agents/revoke', headers: bearer(session), body: body({ id: 'agent-a' })
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(json(revoked), { revoked: true, cancelledCommands: 1 });
  assert.deepEqual(await caller, { ok: false, error: 'This agent was disconnected, so the command was cancelled.', code: 'agent_revoked' });
  assert.equal(await state.commandQueue.poll('browser-a', 1, true, '1.0.7'), null);
  assert.equal(state.commandQueue.record('queued-b').state, 'queued');
  const audit = state.auditLines.map((line) => JSON.parse(line)).find((entry) => entry.tool === 'owner_agent_revoke');
  assert.equal(audit.cancelled, 1);
});

test('owner revoke resolves the pending MCP call with agent_revoked and the reconnected browser receives nothing', async (t) => {
  const state = fixture(t);
  const session = json(await signIn(state.server)).token;
  const agentToken = 'pending-mcp-agent-token-that-is-at-least-32-characters';
  state.agentTokenStore.add(agentToken, { id: 'pending-mcp-agent', capabilities: ['browser.control', 'browser.read'] });
  const browserDigest = 'c'.repeat(64);
  const browser = state.browserRegistry.ensure(browserDigest);
  state.commandQueue.markOnline(browserDigest, true, '1.0.7', 'polling_recovery_active');
  state.commandQueue.hasActivePollingWaiter = () => true;
  const call = invoke(state.server, {
    method: 'POST', url: '/mcp', headers: bearer(agentToken),
    body: body({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'edge_wait', arguments: { browserId: browser.id, ms: 1, timeoutMs: 5_000 } } })
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.commandQueue.state.records.length, 1);
  state.commandQueue.markOffline(browserDigest);

  const revoked = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/agents/revoke', headers: bearer(session), body: body({ id: 'pending-mcp-agent' })
  });
  assert.deepEqual(json(revoked), { revoked: true, cancelledCommands: 1 });
  const response = json(await call);
  assert.equal(response.result._meta.code, 'agent_revoked');
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    error: { code: 'agent_revoked', message: 'This agent was disconnected, so the command was cancelled.' }
  });
  assert.equal(await state.commandQueue.poll(browserDigest, 1, true, '1.0.7'), null);
});

test('owner web-app revoke cancels commands for the OAuth principal id', async (t) => {
  const state = fixture(t);
  const { registration } = await issueOAuthToken(state.oauth);
  const session = json(await signIn(state.server)).token;
  const command = { id: 'queued-oauth', type: 'wait', ms: 1, agentId: `oauth:${registration.client_id}`, createdAt: new Date().toISOString() };
  state.commandQueue.enqueue('browser-oauth', command, 5_000);
  const caller = state.commandQueue.waitForResult('browser-oauth', command.id, 5_000);
  const revoked = await invoke(state.server, {
    method: 'POST', url: '/work-edge/owner/web-apps/revoke', headers: bearer(session), body: body({ clientId: registration.client_id })
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(json(revoked), { revoked: true, cancelledCommands: 1 });
  assert.equal((await caller).code, 'agent_revoked');
  const audit = state.auditLines.map((line) => JSON.parse(line)).find((entry) => entry.tool === 'owner_web_app_revoke');
  assert.equal(audit.cancelled, 1);
});

test('owner pairs a browser without a developer token', async (t) => {
  const { server } = fixture(t);
  const session = json(await signIn(server)).token;
  const paired = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/pair', headers: bearer(session), body: body({})
  });
  assert.equal(paired.status, 201);
  assert.match(json(paired).code, /^[A-Z2-9]{12}$/);
  const exchanged = await invoke(server, {
    method: 'POST', url: '/work-edge/pair/exchange', headers: jsonHeaders, body: body({ code: json(paired).code })
  });
  assert.equal(exchanged.status, 200);
  assert.ok(json(exchanged).token.length >= 43);
});

test('owner session lists browser names and online state for replacement', async (t) => {
  const state = fixture(t);
  const session = json(await signIn(state.server)).token;
  const browser = state.browserRegistry.ensure(createHash('sha256').update('offline-browser').digest('hex'));
  state.browserRegistry.rename(browser.id, 'Office laptop');
  const listed = await invoke(state.server, { method: 'GET', url: '/work-edge/owner/browsers', headers: bearer(session) });
  assert.equal(listed.status, 200);
  assert.deepEqual(json(listed).browsers, [{ id: browser.id, name: 'Office laptop', online: false }]);
  const denied = await invoke(state.server, { method: 'GET', url: '/work-edge/owner/browsers' });
  assert.equal(denied.status, 401);
});

test('re-pair preserves browser identity and revokes the old token', async (t) => {
  const state = fixture(t);
  const session = json(await signIn(state.server)).token;
  const create = async (replacesBrowserId) => json(await invoke(state.server, { method: 'POST', url: '/work-edge/owner/pair',
    headers: bearer(session), body: body(replacesBrowserId ? { replacesBrowserId } : {}) }));
  const exchange = async (code) => json(await invoke(state.server, { method: 'POST', url: '/work-edge/pair/exchange',
    headers: jsonHeaders, body: body({ code }) }));
  const oldToken = (await exchange((await create()).code)).token;
  const oldDigest = createHash('sha256').update(oldToken).digest('hex');
  const browser = state.browserRegistry.ensure(oldDigest);
  state.browserRegistry.rename(browser.id, 'Office laptop');
  state.browserRegistry.setAskBeforeFinalActions(browser.id, false);
  state.browserRegistry.setPrivate(browser.id, true);
  const newToken = (await exchange((await create(browser.id)).code)).token;
  const newDigest = createHash('sha256').update(newToken).digest('hex');
  const kept = state.browserRegistry.byDigest(newDigest);
  assert.equal(kept.id, browser.id);
  assert.equal(kept.name, 'Office laptop');
  assert.equal(kept.private, true);
  assert.equal(kept.askBeforeFinalActions, true);
  assert.equal(kept.shareDelegatedRuns, false);
  assert.equal(kept.isDefault, true);
  assert.equal(state.browserRegistry.byDigest(oldDigest), null);
  assert.equal((await invoke(state.server, { method: 'POST', url: '/work-edge/pair/status', headers: bearer(oldToken), body: body({}) })).status, 401);
  assert.equal((await invoke(state.server, { method: 'POST', url: '/work-edge/pair/status', headers: bearer(newToken), body: body({}) })).status, 200);
  const normalToken = (await exchange((await create()).code)).token;
  assert.notEqual(state.browserRegistry.ensure(createHash('sha256').update(normalToken).digest('hex')).id, browser.id);
});

test('a caller without browser management cannot mint a replacement code', async (t) => {
  const state = fixture(t);
  const browser = state.browserRegistry.ensure('a'.repeat(64));
  const key = 'read-only-agent-key-with-at-least-32-characters';
  state.agentTokenStore.add(key, { id: 'reader', capabilities: ['browser.read'] });
  const response = await invoke(state.server, { method: 'POST', url: '/agent-grants/pair', headers: bearer(key),
    body: body({ replacesBrowserId: browser.id }) });
  assert.equal(response.status, 403);
});

test('owner sign-in is unavailable without a configured passphrase', async (t) => {
  const { server } = fixture(t, { configuredOwnerPassphrase: undefined });
  const response = await signIn(server);
  assert.equal(response.status, 503);
  assert.deepEqual(json(response), { error: 'Owner sign-in is turned off on this server.' });
});

test('app sign-in passphrase is refused for owner sessions', async (t) => {
  const server = serverFromEnv(t);
  const response = await signIn(server, loginPassphrase);
  assert.equal(response.status, 401);
  assert.deepEqual(json(response), { error: 'That passphrase did not match. Try again.' });
});

test('owner sign-in is unavailable when owner and app passphrases are equal', async (t) => {
  const server = serverFromEnv(t, { owner: loginPassphrase, login: loginPassphrase });
  const response = await signIn(server, loginPassphrase);
  assert.equal(response.status, 503);
  assert.deepEqual(json(response), { error: 'Owner sign-in needs its own passphrase, different from the app sign-in passphrase.' });
});

test('OAuth login accepts the app passphrase and refuses the owner passphrase', async (t) => {
  const { server, oauth } = fixture(t);
  const registration = oauth.register({
    client_name: 'Passphrase Boundary App',
    redirect_uris: ['https://app.example.test/callback'],
    token_endpoint_auth_method: 'none'
  });
  const verifier = 'passphrase-boundary-verifier-12345678901234567890';
  const authorize = oauth.authorize({
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  });
  const requestId = new URL(authorize).searchParams.get('req');
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const ownerDenied = await invoke(server, {
    method: 'POST', url: '/login', headers,
    body: new URLSearchParams({ req: requestId, passphrase: ownerPassphrase }).toString()
  });
  assert.equal(ownerDenied.status, 401);
  const appAccepted = await invoke(server, {
    method: 'POST', url: '/login', headers,
    body: new URLSearchParams({ req: requestId, passphrase: loginPassphrase }).toString()
  });
  assert.equal(appAccepted.status, 302);
});

test('owner audit uses fixed tool names for denied known routes and owner_unknown for unknown paths', async (t) => {
  const { server, auditLines } = fixture(t);
  const known = [
    ['GET', '/work-edge/owner/agents', 'owner_agent_list'],
    ['POST', '/work-edge/owner/agents', 'owner_agent_create'],
    ['POST', '/work-edge/owner/agents/revoke', 'owner_agent_revoke'],
    ['POST', '/work-edge/owner/web-apps/revoke', 'owner_web_app_revoke'],
    ['POST', '/work-edge/owner/pair', 'owner_pair'],
    ['DELETE', '/work-edge/owner/session', 'owner_session']
  ];
  for (const [method, url] of known) {
    const response = await invoke(server, { method, url, headers: bearer('forged-owner-session') });
    assert.equal(response.status, 401);
  }
  const unknown = await invoke(server, {
    method: 'GET',
    url: '/work-edge/owner/%3Cscript%3Ex',
    headers: bearer('forged-owner-session')
  });
  assert.equal(unknown.status, 401);
  const entries = auditLines.map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.tool), [...known.map((entry) => entry[2]), 'owner_unknown']);
  assert.equal(auditLines.join('').includes('script'), false);
});

test('owner agent capability overrides accept known grants and reject unknown grants', async (t) => {
  const { server } = fixture(t);
  const session = json(await signIn(server)).token;
  const accepted = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents', headers: bearer(session),
    body: body({ preset: 'other', capabilities: ['browser.read', 'browser.verified.propose'] })
  });
  assert.equal(accepted.status, 201);
  assert.deepEqual(json(accepted).capabilities, ['browser.read', 'browser.verified.propose']);
  const rejected = await invoke(server, {
    method: 'POST', url: '/work-edge/owner/agents', headers: bearer(session),
    body: body({ preset: 'other', capabilities: ['browser.read', 'browser.unknown'] })
  });
  assert.equal(rejected.status, 400);
  assert.match(json(rejected).error, /unknown agent capability/);
});
