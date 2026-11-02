import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { EventLog } from '../broker/src/event-log.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { OwnerSessions } from '../broker/src/owner-session.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['*'],
  denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includePayloadContent: false, includeUrlPath: false }
};

const json = (response) => JSON.parse(response.body);
const bearer = (token) => ({ authorization: `Bearer ${token}` });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-contract-events-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browserToken = 'event-browser-token';
  const browserDigest = createHash('sha256').update(browserToken).digest('hex');
  const agentToken = 'event-agent-token-that-is-at-least-32-characters';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const agentTokenStore = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  agentTokenStore.add(agentToken, { id: 'event-agent', capabilities: ['browser.read', 'browser.control'] });
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  const browser = browserRegistry.ensure(browserDigest);
  browserRegistry.setAskBeforeFinalActions(browser.id, false);
  const commandQueue = new BrowserCommandQueue({ stateFile: '' });
  const ownerSessions = new OwnerSessions({ passphrase: 'owner passphrase for tests', delay: async () => {} });
  const server = createServer({
    policy,
    tokenStore,
    agentTokenStore,
    browserRegistry,
    commandQueue,
    ownerSessions,
    env: { PUBLIC_BASE_URL: 'https://browser.example.test', FBB_DATA_DIR: directory }
  });
  t.after(() => server.close());

  async function callTool(id, tool, args, result = { ok: true }) {
    const polled = commandQueue.poll(browserDigest, 500, true, '1.0.7', 'polling_recovery_active');
    const called = invoke(server, {
      method: 'POST', url: '/mcp',
      headers: { ...bearer(agentToken), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: { browserId: browser.id, ...args } } })
    });
    const command = await polled;
    assert.ok(command?.id);
    commandQueue.submitResult(browserDigest, command.id, { ok: true, result });
    assert.equal((await called).status, 200);
  }

  const events = (after, headers = bearer(agentToken), browserId = browser.id) => invoke(server, {
    url: `/contract/v1/browsers/${browserId}/events${after === undefined ? '' : `?after=${after}`}`,
    headers
  });

  return { server, browser, browserDigest, agentToken, ownerSessions, callTool, events };
}

test('an MCP tool result produces one browser event with its identity and outcome', async (t) => {
  const state = fixture(t);
  await state.callTool(1, 'edge_click', { selector: '#next' });
  const response = await state.events();
  assert.equal(response.status, 200);
  const body = json(response);
  assert.equal(body.events.length, 1);
  assert.deepEqual({
    agentId: body.events[0].agentId,
    type: body.events[0].type,
    tool: body.events[0].tool,
    summary: body.events[0].summary,
    ok: body.events[0].ok
  }, {
    agentId: 'event-agent',
    type: 'tool_result',
    tool: 'edge_click',
    summary: 'Clicked an element',
    ok: true
  });
  assert.equal(body.next, body.events[0].cursor);
});

test('after returns only events with a newer cursor', async (t) => {
  const state = fixture(t);
  await state.callTool(1, 'edge_click', { selector: '#first' });
  const first = json(await state.events());
  await state.callTool(2, 'edge_press', { key: 'Enter' });
  const newer = json(await state.events(first.next));
  assert.equal(newer.events.length, 1);
  assert.equal(newer.events[0].tool, 'edge_press');
});

test('event long-poll resolves when a newer event is appended', async () => {
  const log = new EventLog();
  const waiting = log.wait('browser-a', '0', 1_000);
  setTimeout(() => log.append('browser-a', { agentId: 'agent-a', type: 'tool_result', tool: 'edge_click', ok: true, summary: 'Clicked an element' }), 10);
  const result = await waiting;
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].tool, 'edge_click');
});

test('events rejects an unknown public browser id with contract error shape', async (t) => {
  const response = await fixture(t).events(undefined, undefined, 'brw_deadbeefdeadbeef');
  assert.equal(response.status, 404);
  assert.deepEqual(json(response), { error: { code: 'browser_unknown', message: 'That browser is not known.' } });
});

test('events requires an agent key or owner session', async (t) => {
  const state = fixture(t);
  const response = await state.events(undefined, {});
  assert.equal(response.status, 401);
  assert.deepEqual(json(response), { error: { code: 'unauthorized', message: 'Sign in or provide an agent key.' } });
});

test('an owner session can read browser events', async (t) => {
  const state = fixture(t);
  const signedIn = await state.ownerSessions.signIn({ passphrase: 'owner passphrase for tests', ip: '127.0.0.1' });
  const response = await state.events(undefined, bearer(signedIn.token));
  assert.equal(response.status, 200);
  assert.deepEqual(json(response), { events: [], next: '0' });
});

test('edge_type event summary never contains typed text or selectors', async (t) => {
  const state = fixture(t);
  await state.callTool(1, 'edge_type', { selector: '#private-field', text: 'SECRET-TYPED-VALUE' });
  const output = (await state.events()).body;
  assert.equal(output.includes('SECRET-TYPED-VALUE'), false);
  assert.equal(output.includes('#private-field'), false);
  assert.equal(json({ body: output }).events[0].summary, 'Typed into a field');
});

test('edge_navigate event summary contains only the destination host', async (t) => {
  const state = fixture(t);
  await state.callTool(1, 'edge_navigate', { url: 'https://example.com/path?token=abc' });
  const output = (await state.events()).body;
  assert.equal(output.includes('/path'), false);
  assert.equal(output.includes('token=abc'), false);
  assert.equal(json({ body: output }).events[0].summary, 'Navigated to example.com');
});

test('event ring keeps only the newest 1,000 events per browser', () => {
  const log = new EventLog();
  for (let index = 1; index <= 1_005; index += 1) {
    log.append('browser-a', { agentId: 'agent-a', type: 'tool_result', tool: 'edge_wait', ok: true, summary: `Event ${index}` });
  }
  const result = log.since('browser-a', '0', 2_000);
  assert.equal(result.events.length, 1_000);
  assert.equal(result.events[0].summary, 'Event 6');
  assert.equal(result.events.at(-1).summary, 'Event 1005');
});
