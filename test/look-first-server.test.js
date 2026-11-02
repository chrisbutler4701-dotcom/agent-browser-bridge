import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

// Look before acting and per-tab snapshots, end to end through the broker
// (approved by the owner in 2026-10-22).

const policy = { listen: { host: '127.0.0.1', port: 8765 }, allowOrigins: ['https://approved.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 }, audit: { enabled: false, includeUrlPath: false } };
const digest = (token) => createHash('sha256').update(token).digest('hex');

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-look-first-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserToken = 'c'.repeat(32);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  const claude = agents.create({ id: 'claude-code', capabilities: ['browser.read', 'browser.control'] }).token;
  const codex = agents.create({ id: 'codex', capabilities: ['browser.read', 'browser.control'] }).token;
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const registry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const D = digest(browserToken);
  const browser = registry.ensure(D);
  registry.setAskBeforeFinalActions(browser.id, false);
  queue.markOnline(D, true, '1.4.9');
  const server = createServer({ policy, tokenStore, agentTokenStore: agents, commandQueue: queue, browserRegistry: registry,
    env: { ...process.env, FBB_DATA_DIR: directory, FBB_APPROVAL_WAIT_SECONDS: '1' } });
  t.after(() => server.close());
  return { server, queue, registry, D, browser, browserToken, claude, codex };
}

async function mcp(server, token, id, name, args) {
  const response = await invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  return JSON.parse(response.body);
}

async function ingest(server, browserToken, capture) {
  const response = await invoke(server, { method: 'POST', url: '/work-edge/ingest', headers: { 'content-type': 'application/json', authorization: `Bearer ${browserToken}` }, body: JSON.stringify({ title: 'Page', text: 'text', elementSummary: [], capturedAt: new Date().toISOString(), userInitiated: true, ...capture }) });
  assert.equal(response.statusCode ?? response.status, 202, response.body);
}

async function act(server, queue, D, token, id, name, args, browserResult) {
  const poll = queue.poll(D, 1_000, true, '1.4.9');
  const call = mcp(server, token, id, name, args);
  const command = await poll;
  queue.submitResult(D, command.id, browserResult(command));
  return { command, response: await call };
}

test('snapshots are kept per tab, so reading one tab never returns another', async (t) => {
  const { server, browserToken, browser, claude } = setup(t);
  await ingest(server, browserToken, { tabId: 1, url: 'https://approved.example/one', text: 'first tab' });
  await ingest(server, browserToken, { tabId: 2, url: 'https://approved.example/two', text: 'second tab' });
  const one = await mcp(server, claude, 1, 'edge_snapshot', { browserId: browser.id, tabId: 1 });
  assert.match(one.result.content[0].text, /first tab/);
  const tabs = JSON.parse((await mcp(server, claude, 2, 'edge_list_tabs', { browserId: browser.id })).result.content[0].text);
  assert.deepEqual(tabs.map((tab) => tab.id).sort(), [1, 2]);
  const missing = await mcp(server, claude, 3, 'edge_snapshot', { browserId: browser.id, tabId: 9 });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /edge_read_tab/);
});

test('snapshot exposes writable fields without form values or buttons', async (t) => {
  const { server, browserToken, browser, claude } = setup(t);
  const ref = 'fbb-frame:2::work-edge-search-1';
  await ingest(server, browserToken, { tabId: 3, url: 'https://approved.example/jobs', elementSummary: [
    { ref, tag: 'input', type: 'search', role: 'searchbox', name: 'Search jobs', hasValue: true, value: 'private query' },
    { ref: 'work-edge-save-1', tag: 'button', text: 'Save' },
  ] });
  const snapshot = JSON.parse((await mcp(server, claude, 1, 'edge_snapshot', { browserId: browser.id, tabId: 3 })).result.content[0].text);
  assert.deepEqual(snapshot.fields, [{ ref, tag: 'input', type: 'search', role: 'searchbox', name: 'Search jobs', hasValue: true }]);
  assert.equal(JSON.stringify(snapshot).includes('private query'), false);
});

test('reading a tab is recorded per agent and sent with that agent\'s next click', async (t) => {
  const { server, queue, D, browser, browserToken, claude, codex } = setup(t);
  await ingest(server, browserToken, { tabId: 2, url: 'https://approved.example/records?token=secret' });
  await mcp(server, claude, 1, 'edge_snapshot', { browserId: browser.id, tabId: 2 });
  const { command } = await act(server, queue, D, claude, 2, 'edge_click', { browserId: browser.id, tabId: 2, selector: '#open' }, () => ({ ok: true, result: {} }));
  assert.deepEqual(command.seenPages, { 2: 'https://approved.example/records' });
  assert.equal(command.tabId, 2);

  // Another agent has not looked, so its map is empty.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const other = await act(server, queue, D, codex, 3, 'edge_wait', { browserId: browser.id, ms: 1 }, () => ({ ok: true, result: {} })).catch(() => null);
  assert.ok(other === null || other.command.seenPages === undefined, 'wait carries no seen map');
});

test('a look-first refusal reaches the agent with the fresh snapshot, and unlocks the retry', async (t) => {
  const { server, queue, D, browser, claude } = setup(t);
  const page = { tabId: 4, address: 'https://approved.example/inbox' };
  const refused = await act(server, queue, D, claude, 1, 'edge_click', { browserId: browser.id, tabId: 4, selector: '#row' },
    () => ({ ok: false, code: 'look_first', error: 'Look first.', result: { page, capture: { title: 'Inbox', text: 'fresh' } } }));
  assert.equal(refused.response.result.isError, true);
  assert.equal(refused.response.result._meta.code, 'look_first');
  const payload = JSON.parse(refused.response.result.content[0].text);
  assert.deepEqual(payload.error.page, page);
  assert.equal(payload.error.capture.text, 'fresh');

  const retry = await act(server, queue, D, claude, 2, 'edge_click', { browserId: browser.id, tabId: 4, selector: '#row' }, () => ({ ok: true, result: {} }));
  assert.deepEqual(retry.command.seenPages, { 4: 'https://approved.example/inbox' });
});

test('ask-on inspection leaves look-first for the real non-final click', async (t) => {
  const { server, queue, registry, D, browser, browserToken, claude } = setup(t);
  registry.setAskBeforeFinalActions(browser.id, true);
  await ingest(server, browserToken, { tabId: 5, url: 'https://approved.example/inbox' });
  await mcp(server, claude, 1, 'edge_snapshot', { browserId: browser.id, tabId: 5 });

  const inspectPoll = queue.poll(D, 1_000, true, '1.4.9');
  const call = mcp(server, claude, 2, 'edge_click', { browserId: browser.id, tabId: 5, selector: '#open' });
  const inspection = await inspectPoll;
  assert.equal(inspection.type, 'inspect_action');
  assert.equal(inspection.seenPages, undefined);
  queue.submitResult(D, inspection.id, { ok: true, result: { finalAction: false, tabId: 5 } });
  const clickPoll = queue.poll(D, 1_000, true, '1.4.9');
  const click = await clickPoll;
  assert.equal(click.type, 'click');
  assert.deepEqual(click.seenPages, { 5: 'https://approved.example/inbox' });
  queue.submitResult(D, click.id, { ok: true, result: { clicked: true } });
  assert.equal(JSON.parse((await call).result.content[0].text).ok, true);
  const approvals = await invoke(server, { url: `/contract/v1/approvals?browserId=${browser.id}`, headers: { authorization: `Bearer ${claude}` } });
  assert.deepEqual(JSON.parse(approvals.body).approvals, []);
});

test('ask-on final click creates an approval after inspection', async (t) => {
  const { server, queue, registry, D, browser, browserToken, claude } = setup(t);
  registry.setAskBeforeFinalActions(browser.id, true);
  await ingest(server, browserToken, { tabId: 6, url: 'https://approved.example/inbox' });
  await mcp(server, claude, 1, 'edge_snapshot', { browserId: browser.id, tabId: 6 });

  const inspectPoll = queue.poll(D, 1_000, true, '1.4.9');
  const call = mcp(server, claude, 2, 'edge_click', { browserId: browser.id, tabId: 6, selector: '#send' });
  const inspection = await inspectPoll;
  assert.equal(inspection.type, 'inspect_action');
  assert.equal(inspection.seenPages, undefined);
  queue.submitResult(D, inspection.id, { ok: true, result: { finalAction: true, name: 'Send', fingerprint: 'abc12345',
    url: 'https://approved.example/inbox', title: 'Inbox', tabId: 6 } });
  let approvals;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await invoke(server, { url: `/contract/v1/approvals?browserId=${browser.id}`, headers: { authorization: `Bearer ${claude}` } });
    approvals = JSON.parse(response.body).approvals;
    if (approvals.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].proposal.target.name, 'Send');
  assert.equal((await call).result._meta.code, 'approval_pending');
});

test('an inspection look-first page is recorded for the next ask-on click', async (t) => {
  const { server, queue, registry, D, browser, claude } = setup(t);
  registry.setAskBeforeFinalActions(browser.id, true);
  const page = { tabId: 7, address: 'https://approved.example/new' };
  const firstPoll = queue.poll(D, 1_000, true, '1.4.9');
  const firstCall = mcp(server, claude, 1, 'edge_click', { browserId: browser.id, tabId: 7, selector: '#open' });
  const firstInspection = await firstPoll;
  queue.submitResult(D, firstInspection.id, { ok: false, code: 'look_first', result: { page } });
  assert.equal((await firstCall).result._meta.code, 'look_first');
  const secondPoll = queue.poll(D, 1_000, true, '1.4.9');
  const secondCall = mcp(server, claude, 2, 'edge_click', { browserId: browser.id, tabId: 7, selector: '#open' });
  const secondInspection = await secondPoll;
  queue.submitResult(D, secondInspection.id, { ok: true, result: { finalAction: false, tabId: 7 } });
  const click = await queue.poll(D, 1_000, true, '1.4.9');
  assert.deepEqual(click.seenPages, { 7: 'https://approved.example/new' });
  queue.submitResult(D, click.id, { ok: true, result: { clicked: true } });
  assert.equal(JSON.parse((await secondCall).result.content[0].text).ok, true);
});

async function actViaRoute(server, queue, D, browserToken, token, id, name, args, body) {
  const poll = queue.poll(D, 1_000, true, '1.4.9');
  const call = mcp(server, token, id, name, args);
  const command = await poll;
  const posted = await invoke(server, { method: 'POST', url: '/work-edge/commands/result', headers: { 'content-type': 'application/json', authorization: `Bearer ${browserToken}` }, body: JSON.stringify({ id: command.id, ...body }) });
  assert.ok([200, 202].includes(posted.statusCode ?? posted.status), posted.body);
  return { command, response: await call };
}

test('the browser result route passes allowed codes and drops broker-only ones', async (t) => {
  const { server, queue, D, browser, browserToken, claude } = setup(t);
  const allowed = await actViaRoute(server, queue, D, browserToken, claude, 1, 'edge_scroll', { browserId: browser.id, direction: 'down', tabId: 3 }, { ok: false, code: 'tab_not_found', error: 'Tab 3 is no longer open.' });
  assert.equal(allowed.response.result._meta.code, 'tab_not_found');
  const spoofed = await actViaRoute(server, queue, D, browserToken, claude, 2, 'edge_scroll', { browserId: browser.id, direction: 'down' }, { ok: false, code: 'agent_revoked', error: 'spoofed' });
  assert.equal(spoofed.response.result._meta.code, 'browser_denied');
});
