import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createRunGrants } from '../broker/src/run-grants.js';
import { scopeRunBrowserArgs, visibleRunBrowsers } from '../broker/src/run-grants.js';
import { canUseTool, normalizeCapabilities } from '../broker/src/agent-capabilities.js';
import { createServer } from '../broker/src/server.js';
import { OAuthProvider } from '../broker/src/oauth.js';
import { invoke } from './http-harness.js';

const browserA = 'brw_1111111111111111';
const browserB = 'brw_2222222222222222';
const policy = { listen: { host: '127.0.0.1', port: 0 }, allowOrigins: [], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false } };

test('privacy management is a separate grant with no browser tool authority', () => {
  assert.deepEqual(normalizeCapabilities(['manage_browser_privacy']), ['manage_browser_privacy']);
  assert.equal(canUseTool({ capabilities: ['manage_browser_privacy'] }, 'edge_snapshot'), false);
});

test('auto-provision configuration cannot grant private-browser access', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-privacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createServer({ policy, env: { FBB_DATA_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1:8767',
    WORK_EDGE_AUTO_PROVISION_CAPABILITIES: 'browser.read,private_browser_local' } }), /cannot include private_browser_local/u);
});

test('sharing route requires its grant and audits Cockpit key changes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sharing-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const registry = new BrowserRegistry({ filePath: join(dir, 'registry.json') });
  const browserId = registry.ensure('1'.repeat(64)).id;
  agents.add('a'.repeat(32), { id: 'old-cockpit', capabilities: ['browser.read'] });
  agents.add('b'.repeat(32), { id: 'cockpit', capabilities: ['browser.read', 'manage_browser_privacy', 'private_browser_local'] });
  const audits = [];
  const server = createServer({ policy: { ...policy, audit: { ...policy.audit, enabled: true } }, agentTokenStore: agents, browserRegistry: registry, auditWriter: (line) => audits.push(JSON.parse(line)), env: { FBB_DATA_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1:8767' } });
  const change = (key, enabled) => invoke(server, { method: 'POST', url: '/agent-grants/privacy', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ browserId, private: enabled }) });
  assert.equal((await change('a'.repeat(32), true)).status, 403);
  assert.ok(audits.some((entry) => entry.tool === 'owner_browser_privacy' && entry.outcome === 'denied' && entry.agentId === 'old-cockpit'));
  assert.equal(registry.byId(browserId) !== null && registry.byDigest('1'.repeat(64)).private, false);
  const updated = await change('b'.repeat(32), true);
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(updated.body), { browserId, private: true });
  assert.equal(registry.byDigest('1'.repeat(64)).private, true);
  assert.ok(audits.some((entry) => entry.tool === 'owner_browser_privacy' && entry.source === 'cockpit-key' && entry.browserId === browserId));
});

test('run grants expire and revoke without retaining bearer material', () => {
  let clock = 1000;
  const grants = createRunGrants({ now: () => clock });
  const first = grants.issue({ runId: 'run-1', browserId: browserA, lane: 'codex', ttlSeconds: 60, issuerId: 'cockpit', issuerVersion: 1, issuerCapabilities: ['browser.read'] });
  assert.equal(grants.authorize(first.bearer).browserId, browserA);
  assert.deepEqual(grants.authorize(first.bearer).capabilities, ['browser.read']);
  assert.equal(grants.revoke('run-1', 'other'), false);
  assert.equal(grants.revoke('run-1', 'cockpit'), true);
  assert.equal(grants.authorize(first.bearer), null);
  assert.throws(() => grants.issue({ runId: 'run-1', browserId: browserB, lane: 'claude', ttlSeconds: 60, issuerId: 'cockpit', issuerVersion: 1, issuerCapabilities: ['browser.read'] }), /already been granted/);
  const second = grants.issue({ runId: 'run-2', browserId: browserB, lane: 'claude', ttlSeconds: 60, issuerId: 'cockpit', issuerVersion: 1, issuerCapabilities: ['browser.read'] });
  assert.deepEqual(grants.authorize(second.bearer).capabilities, ['browser.read']);
  assert.equal(canUseTool(grants.authorize(second.bearer), 'edge_click'), false);
  assert.match(grants.authorize(second.bearer).id, /^fbg:/);
  clock += 60000;
  assert.equal(grants.authorize(second.bearer), null);
  assert.throws(() => grants.issue({ runId: 'run-3', browserId: browserA, lane: 'codex', ttlSeconds: 1801, issuerId: 'cockpit' }));
  const full = grants.issue({ runId: 'run-4', browserId: browserA, lane: 'claude', ttlSeconds: 60, issuerId: 'cockpit', issuerVersion: 1, issuerCapabilities: ['browser.read', 'browser.control', 'browser.verified.execute'] });
  assert.equal(canUseTool(grants.authorize(full.bearer), 'edge_click'), true);
  assert.equal(canUseTool(grants.authorize(full.bearer), 'edge_verified_action_execute'), true);
});

test('grant cap, timer pruning, and reserved agent prefix', (t) => {
  let clock = 0;
  const grants = createRunGrants({ now: () => clock });
  for (let index = 0; index < 50; index++) grants.issue({ runId: `run-${index}`, browserId: browserA, lane: 'codex', ttlSeconds: 60, issuerId: 'cockpit', issuerCapabilities: ['browser.read'] });
  assert.throws(() => grants.issue({ runId: 'run-50', browserId: browserA, lane: 'codex', ttlSeconds: 60, issuerId: 'cockpit', issuerCapabilities: ['browser.read'] }), /too many/);
  clock = 60_000; grants.prune();
  assert.equal(grants.issue({ runId: 'run-50', browserId: browserA, lane: 'codex', ttlSeconds: 60, issuerId: 'cockpit', issuerCapabilities: ['browser.read'] }).bearer.startsWith('fbg_'), true);
  const dir = mkdtempSync(join(tmpdir(), 'agent-prefix-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new AgentTokenStore({ filePath: join(dir, 'agents.json') }).add('a'.repeat(32), { id: 'fbg:fake', capabilities: ['browser.read'] }));
});

test('run id reuse is blocked through max TTL plus grace and released by pruning', () => {
  let clock = 0;
  const grants = createRunGrants({ now: () => clock });
  const issue = () => grants.issue({ runId: 'reusable', browserId: browserA, lane: 'codex', ttlSeconds: 60,
    issuerId: 'cockpit', issuerCapabilities: ['browser.read'] });
  issue();
  assert.equal(grants.revoke('reusable', 'cockpit'), true);
  clock = 1_859_999; grants.prune();
  assert.throws(issue, /already been granted/);
  clock = 1_860_000; grants.prune();
  assert.ok(issue().bearer.startsWith('fbg_'));
});

test('browser privacy defaults open and persists on owner change', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-sharing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'registry.json');
  const registry = new BrowserRegistry({ filePath });
  const browser = registry.ensure('1'.repeat(64));
  assert.equal(browser.private, false);
  assert.equal(new BrowserRegistry({ filePath }).byDigest('1'.repeat(64)).shareDelegatedRuns, true);
  registry.setPrivate(browser.id, true);
  assert.equal(new BrowserRegistry({ filePath }).byDigest('1'.repeat(64)).shareDelegatedRuns, false);
  assert.throws(() => registry.setPrivate(browser.id, 'true'));
  const legacy = JSON.parse(readFileSync(filePath, 'utf8'));
  legacy.browsers['1'.repeat(64)].shareDelegatedRuns = false;
  delete legacy.browsers['1'.repeat(64)].private;
  writeFileSync(filePath, JSON.stringify(legacy));
  assert.equal(new BrowserRegistry({ filePath }).byDigest('1'.repeat(64)).private, false);
});

test('private browser blocks static and OAuth principals, but allows the local Cockpit key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-browser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const registry = new BrowserRegistry({ filePath: join(dir, 'registry.json') });
  const id = registry.ensure('1'.repeat(64)).id;
  registry.setPrivate(id, true);
  agents.add('a'.repeat(32), { id: 'agent', capabilities: ['browser.read', 'browser.control'] });
  agents.add('b'.repeat(32), { id: 'cockpit', capabilities: ['browser.read', 'private_browser_local'] });
  const oauth = new OAuthProvider({ publicBaseUrl: 'http://127.0.0.1:8767', stateFile: join(dir, 'oauth.json') });
  oauth.authenticate = (token) => token === 'oauth-test-token' ? { id: 'oauth:test', source: 'oauth', capabilities: ['browser.read'] } : null;
  const server = createServer({ policy, agentTokenStore: agents, browserRegistry: registry, oauthProvider: oauth,
    env: { FBB_DATA_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1:8767' } });
  const read = (key) => invoke(server, { url: `/contract/v1/browsers/${id}/status`, headers: { authorization: `Bearer ${key}`, 'fbb-contract-version': '1' } });
  for (const key of ['a'.repeat(32), 'oauth-test-token']) {
    const denied = await read(key);
    assert.equal(denied.status, 403);
    assert.match(JSON.parse(denied.body).error.message, /This browser is private\./u);
  }
  const local = await read('b'.repeat(32));
  assert.notEqual(local.status, 403);
});

test('private browser blocks run grants and an open browser gives codex click authority', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const registry = new BrowserRegistry({ filePath: join(dir, 'registry.json') });
  const browserId = registry.ensure('1'.repeat(64)).id;
  agents.add('a'.repeat(32), { id: 'cockpit', capabilities: ['delegate_runs', 'browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute', 'private_browser_local'] });
  const server = createServer({ policy, agentTokenStore: agents, browserRegistry: registry,
    env: { FBB_DATA_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1:8767' } });
  const issue = (runId) => invoke(server, { method: 'POST', url: '/agent-grants',
    headers: { authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, browser_id: browserId, lane: 'codex', ttl_seconds: 60 }) });
  registry.setPrivate(browserId, true);
  assert.equal((await issue('private')).status, 403);
  registry.setPrivate(browserId, false);
  const grant = JSON.parse((await issue('open')).body);
  const listed = await invoke(server, { method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${grant.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const names = JSON.parse(listed.body).result.tools.map((tool) => tool.name);
  assert.ok(names.includes('edge_click'));
  assert.ok(names.includes('edge_verified_action_execute'));
  registry.setPrivate(browserId, true);
  const denied = await invoke(server, { method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${grant.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edge_snapshot', arguments: { browserId } } }) });
  assert.match(JSON.parse(denied.body).result.content[0].text, /This browser is private\./u);
});

test('run principal stays pinned to one browser', () => {
  const principal = { source: 'run-grant', browserId: browserA, capabilities: ['browser.read'] };
  assert.deepEqual(scopeRunBrowserArgs(principal, {}).args, { browserId: browserA });
  assert.equal(scopeRunBrowserArgs(principal, { browserId: browserB }).allowed, false);
  assert.deepEqual(visibleRunBrowsers(principal, [{ id: browserA }, { id: browserB }]), [{ id: browserA }]);
  assert.equal(canUseTool(principal, 'edge_snapshot'), true);
  assert.equal(canUseTool(principal, 'edge_click'), false);
});

test('every lane receives full browser authority only when the issuer has it', () => {
  const grants = createRunGrants();
  for (const lane of ['claude', 'codex', 'agy', 'hermes']) {
    const full = grants.issue({ runId: `full-${lane}`, browserId: browserA, lane, ttlSeconds: 60, issuerId: 'cockpit',
      issuerCapabilities: ['browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute'] });
    assert.equal(canUseTool(grants.authorize(full.bearer), 'edge_click'), true);
    assert.equal(canUseTool(grants.authorize(full.bearer), 'edge_verified_action_execute'), true);
    const limited = grants.issue({ runId: `limited-${lane}`, browserId: browserA, lane, ttlSeconds: 60, issuerId: 'limited',
      issuerCapabilities: ['browser.read'] });
    assert.equal(canUseTool(grants.authorize(limited.bearer), 'edge_click'), false);
  }
});

test('private browser denies grants while open browser gives codex full issuer-bounded authority', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const registry = new BrowserRegistry({ filePath: join(dir, 'registry.json') });
  agents.add('a'.repeat(32), { id: 'cockpit', capabilities: ['delegate_runs', 'browser.read', 'browser.control', 'browser.verified.propose', 'browser.verified.execute', 'private_browser_local'] });
  registry.ensure('1'.repeat(64)); registry.ensure('2'.repeat(64));
  const ids = registry.list().map((browser) => browser.id);
  let clock = Date.now();
  const server = createServer({ policy, agentTokenStore: agents, browserRegistry: registry, runGrants: createRunGrants({ now: () => clock }), env: { FBB_DATA_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1:8767' } });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Sandbox blocks loopback listeners.'); return; } throw error; }
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const issueRequest = (runId, lane = 'codex') => fetch(`${base}/agent-grants`, { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, browser_id: ids[0], lane, ttl_seconds: 60 }) });
  registry.setPrivate(ids[0], true);
  assert.equal((await issueRequest('private')).status, 403);
  registry.setPrivate(ids[0], false);
  const issue = await fetch(`${base}/agent-grants`, { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: 'run-1', browser_id: ids[0], lane: 'codex', ttl_seconds: 1800 }) });
  assert.equal(issue.status, 201);
  const grant = await issue.json();
  const call = (name, args = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${grant.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((response) => response.json());
  const listed = await call('edge_list_browsers');
  assert.deepEqual(JSON.parse(listed.result.content[0].text).browsers.map((browser) => browser.id), [ids[0]]);
  assert.equal((await call('edge_snapshot', { browserId: ids[1] })).error.code, -32003);
  assert.equal((await call('edge_click', { browserId: ids[0], selector: '#x' })).result.isError, true);
  const outside = await fetch(`${base}/contract/v1/me`, { headers: { authorization: `Bearer ${grant.bearer}`, 'fbb-contract-version': '1' } });
  assert.equal(outside.status, 401);
  const owner = await fetch(`${base}/work-edge/owner/agents`, { headers: { authorization: `Bearer ${grant.bearer}` } });
  assert.equal(owner.status, 401);
  const claudeResponse = await issueRequest('claude-run', 'claude');
  assert.equal(claudeResponse.status, 201);
  const claude = await claudeResponse.json();
  const toolsList = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${claude.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) }).then((response) => response.json());
  assert.ok(toolsList.result.tools.some((tool) => tool.name === 'edge_click'));
  assert.ok(toolsList.result.tools.some((tool) => tool.name === 'edge_verified_action_execute'));
  const codexTools = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${grant.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }) }).then((response) => response.json());
  assert.ok(codexTools.result.tools.some((tool) => tool.name === 'edge_click'));
  registry.setPrivate(ids[0], true);
  assert.match((await call('edge_snapshot', { browserId: ids[0] })).result.content[0].text, /This browser is private\./u);
  registry.setPrivate(ids[0], false);
  clock += 60_000;
  const expired = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${claude.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) });
  assert.equal(expired.status, 401);
  clock -= 60_000;
  await fetch(`${base}/agent-grants/run-1`, { method: 'DELETE', headers: { authorization: `Bearer ${'a'.repeat(32)}` } });
  const revoked = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${grant.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(revoked.status, 401);
  const thirdResponse = await issueRequest('issuer-revoke');
  const third = await thirdResponse.json();
  agents.revoke('cockpit');
  const killed = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${third.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) });
  assert.equal(killed.status, 401);
});
