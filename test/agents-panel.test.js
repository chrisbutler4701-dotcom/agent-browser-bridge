import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAgentsPanel } from '../extension/agents-panel.js';

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.textContent = '';
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async trigger(type) { return this.listeners.get(type)?.({ target: this, preventDefault() {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() { this.focused = true; }
  querySelectorAll(selector) { return selector === 'button' ? this.children.filter((child) => child.tagName === 'BUTTON') : []; }
  queryByText(text) {
    if (this.textContent === text) return this;
    for (const child of this.children) {
      const match = child.queryByText?.(text);
      if (match) return match;
    }
    return null;
  }
  snapshot() {
    const own = [this.id && `#${this.id}`, this.hidden && '[hidden]', this.textContent, this.value].filter(Boolean).join(' ');
    return [own, ...this.children.map((child) => child.snapshot?.() || '')].filter(Boolean).join('\n');
  }
}

function fakeDocument() {
  const ids = [
    'agentsCard', 'agentsSignedOut', 'ownerPassphrase', 'ownerSignIn', 'agentsSignedIn', 'agentPreset',
    'allowVerifiedPropose', 'allowVerifiedExecute', 'connectAgent', 'agentResult', 'agentsList',
    'pairFromOwner', 'ownerPairChoices', 'ownerSignOut', 'agentsStatus'
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement('div', id)]));
  elements.ownerPassphrase.tagName = 'INPUT';
  elements.ownerPassphrase.type = 'password';
  elements.agentPreset.tagName = 'SELECT';
  elements.agentPreset.value = 'claude-code';
  elements.allowVerifiedPropose.tagName = 'INPUT';
  elements.allowVerifiedExecute.tagName = 'INPUT';
  elements.agentsSignedIn.hidden = true;
  elements.pairFromOwner.hidden = true;
  elements.ownerPairChoices.hidden = true;
  return {
    elements,
    querySelector(selector) { return selector.startsWith('#') ? elements[selector.slice(1)] || null : null; },
    createElement(tagName) { return new FakeElement(tagName); }
  };
}

function storageArea(initial = {}) {
  const values = { ...initial };
  const writes = [];
  return {
    values, writes,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
    },
    async set(update) { writes.push(structuredClone(update)); Object.assign(values, update); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  };
}

const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, async json() { return structuredClone(value); } });

function fixture({ local = {}, session = {}, routes = [], paired = true } = {}) {
  const document = fakeDocument();
  const areas = { local: storageArea(local), session: storageArea(session), sync: storageArea() };
  const fetchCalls = [];
  const runtimeMessages = [];
  const fetch = async (url, options = {}) => {
    const parsedBody = options.body ? JSON.parse(options.body) : null;
    fetchCalls.push({ url, options, body: parsedBody });
    const route = routes.find((candidate) => candidate.method === (options.method || 'GET') && candidate.path === new URL(url).pathname && !candidate.used);
    if (!route) throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
    route.used = true;
    return reply(route.status, typeof route.body === 'function' ? route.body(parsedBody) : route.body);
  };
  const chrome = {
    storage: areas,
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(structuredClone(message));
        if (message.type === 'broker-status') return { configured: true, paired };
        if (message.type === 'pair-browser') return { ok: true };
        throw new Error(`Unexpected runtime message: ${message.type}`);
      }
    }
  };
  const copied = [];
  const navigator = { clipboard: { async writeText(value) { copied.push(value); } } };
  const panel = initializeAgentsPanel({ document, chrome, fetch, navigator });
  return { document, areas, fetchCalls, runtimeMessages, copied, panel };
}

const listBody = (agents = [], webApps = [], approvers = []) => ({ mcpUrl: 'https://browser.example.test/mcp', agents, webApps, approvers });
const signInRoute = { method: 'POST', path: '/work-edge/owner/session', status: 200, body: { token: 'owner-session-value', expiresAt: '2030-01-01T00:00:00.000Z' } };

test('agent panel sign-in stores the owner session only in chrome.storage.session', async () => {
  const state = fixture({ local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' }, routes: [
    { ...signInRoute },
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }
  ] });
  await state.panel.ready;
  state.document.elements.ownerPassphrase.value = 'correct horse';
  await state.document.elements.ownerSignIn.trigger('click');
  assert.equal(state.areas.session.values.ownerSession.token, 'owner-session-value');
  assert.equal(state.areas.local.values.ownerSession, undefined);
  assert.equal(state.areas.sync.values.ownerSession, undefined);
  assert.equal(JSON.stringify(state.areas).includes('correct horse'), false);
  assert.equal(state.document.elements.agentsSignedOut.hidden, true);
});

test('creating Claude Code shows a one-time read-only setup and reopening never restores the key', async () => {
  const agentKey = 'agent-key-only-in-create-response-123456789012345';
  const agent = { id: 'claude-code', capabilities: ['browser.read', 'browser.control'], createdAt: '2030-01-01T00:00:00.000Z' };
  const state = fixture({ local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' }, routes: [
    { ...signInRoute },
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() },
    { method: 'POST', path: '/work-edge/owner/agents', status: 201, body: { ...agent, token: agentKey, mcpUrl: 'https://browser.example.test/mcp', setup: { kind: 'command', text: `claude mcp add ${agentKey}` } } },
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody([agent]) }
  ] });
  await state.panel.ready;
  state.document.elements.ownerPassphrase.value = 'correct horse';
  await state.document.elements.ownerSignIn.trigger('click');
  await state.document.elements.connectAgent.trigger('click');
  const textarea = state.document.elements.agentResult.children.find((child) => child.tagName === 'TEXTAREA');
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes(agentKey));
  assert.equal(JSON.stringify(state.areas).includes(agentKey), false);

  const reopened = fixture({
    local: structuredClone(state.areas.local.values), session: structuredClone(state.areas.session.values),
    routes: [{ method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody([agent]) }]
  });
  await reopened.panel.ready;
  assert.equal(reopened.document.elements.agentResult.snapshot().includes(agentKey), false);
  assert.match(reopened.document.elements.agentsList.snapshot(), /claude-code/);
});

test('disconnect revokes an agent and removes its connected-agent row', async () => {
  const agent = { id: 'codex', capabilities: ['browser.read'], createdAt: '2030-01-01T00:00:00.000Z' };
  const state = fixture({
    local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' },
    session: { ownerSession: { token: 'owner-session-value' } },
    routes: [
      { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody([agent]) },
      { method: 'POST', path: '/work-edge/owner/agents/revoke', status: 200, body: { revoked: true } },
      { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }
    ]
  });
  await state.panel.ready;
  await state.document.elements.agentsList.queryByText('Disconnect').trigger('click');
  assert.equal(state.fetchCalls.some((call) => call.url.endsWith('/work-edge/owner/agents/revoke') && call.body.id === 'codex'), true);
  assert.equal(state.document.elements.agentsList.snapshot().includes('codex'), false);
});

test('agent panel lists approval apps separately and disconnects one', async () => {
  const approver = { id: 'apr_1234', label: 'Cockpit office', createdAt: '2030-01-01T00:00:00.000Z' };
  const state = fixture({
    local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' },
    session: { ownerSession: { token: 'owner-session-value' } },
    routes: [
      { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody([], [], [approver]) },
      { method: 'POST', path: '/work-edge/owner/approvers/revoke', status: 200, body: { revoked: true } },
      { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }
    ]
  });
  await state.panel.ready;
  assert.match(state.document.elements.agentsList.snapshot(), /Approval apps/);
  assert.match(state.document.elements.agentsList.snapshot(), /Cockpit office/);
  await state.document.elements.agentsList.queryByText('Disconnect').trigger('click');
  assert.equal(state.fetchCalls.some((call) => call.url.endsWith('/work-edge/owner/approvers/revoke') && call.body.id === 'apr_1234'), true);
  assert.equal(state.document.elements.agentsList.snapshot().includes('Cockpit office'), false);
});

test('a 401 from an owner call clears the session and asks for the owner passphrase', async () => {
  const state = fixture({
    local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' },
    session: { ownerSession: { token: 'expired-owner-session' } },
    routes: [{ method: 'GET', path: '/work-edge/owner/agents', status: 401, body: { error: 'Sign in again with your owner passphrase.' } }]
  });
  await state.panel.ready;
  assert.equal(state.document.elements.agentsSignedOut.hidden, false);
  assert.equal(state.document.elements.agentsSignedIn.hidden, true);
  assert.equal(state.areas.session.values.ownerSession, undefined);
  assert.equal(state.document.elements.agentsStatus.textContent, 'Sign in again with your owner passphrase.');
});

test('Claude.ai and ChatGPT show a copyable MCP URL without creating an agent key', async () => {
  const state = fixture({ local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' }, routes: [
    { ...signInRoute },
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }
  ] });
  await state.panel.ready;
  state.document.elements.ownerPassphrase.value = 'correct horse';
  await state.document.elements.ownerSignIn.trigger('click');
  for (const preset of ['claude-ai', 'chatgpt']) {
    state.document.elements.agentPreset.value = preset;
    await state.document.elements.connectAgent.trigger('click');
    assert.match(state.document.elements.agentResult.snapshot(), /https:\/\/browser\.example\.test\/mcp/);
  }
  assert.equal(state.fetchCalls.some((call) => call.url.endsWith('/work-edge/owner/agents') && call.options.method === 'POST'), false);
  await state.document.elements.agentResult.queryByText('Copy').trigger('click');
  assert.deepEqual(state.copied, ['https://browser.example.test/mcp']);
  assert.match(state.document.elements.agentResult.snapshot(), /Copied\./);
});

test('pair button appears only when unpaired and pairs through the existing runtime message', async () => {
  const unpaired = fixture({
    paired: false,
    local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' },
    session: { ownerSession: { token: 'owner-session-value' } },
    routes: [
      { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() },
      { method: 'GET', path: '/work-edge/owner/browsers', status: 200, body: { browsers: [] } },
      { method: 'POST', path: '/work-edge/owner/pair', status: 201, body: { code: 'ABCDEFGH2345' } }
    ]
  });
  await unpaired.panel.ready;
  assert.equal(unpaired.document.elements.pairFromOwner.hidden, false);
  await unpaired.document.elements.pairFromOwner.trigger('click');
  await unpaired.document.elements.ownerPairChoices.queryByText('Pair as a new browser').trigger('click');
  assert.deepEqual(unpaired.runtimeMessages.at(-1), { type: 'pair-browser', code: 'ABCDEFGH2345' });

  const paired = fixture({
    paired: true,
    local: { brokerUrl: 'https://browser.example.test/work-edge/ingest' },
    session: { ownerSession: { token: 'owner-session-value' } },
    routes: [{ method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }]
  });
  await paired.panel.ready;
  assert.equal(paired.document.elements.pairFromOwner.hidden, true);
});

test('owner pairing offers only offline browsers for replacement and sends their id', async () => {
  const state = fixture({ paired: false, local: { brokerUrl: 'https://bridge.example.com/work-edge/ingest' }, session: { ownerSession: { token: 'owner-session-value' } }, routes: [
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() },
    { method: 'GET', path: '/work-edge/owner/browsers', status: 200, body: { browsers: [
      { id: 'old-private', name: 'Office laptop', online: false }, { id: 'live', name: 'Home Mac', online: true }
    ] } },
    { method: 'POST', path: '/work-edge/owner/pair', status: 201, body: { code: 'ABCDEFGH2345' } }
  ] });
  await state.panel.ready;
  await state.document.elements.pairFromOwner.trigger('click');
  const choices = state.document.elements.ownerPairChoices;
  assert.match(choices.snapshot(), /Replace Office laptop \(keeps its settings, including Private\)/);
  assert.doesNotMatch(choices.snapshot(), /Home Mac/);
  assert.equal(choices.children[0].focused, true);
  await choices.children[0].trigger('click');
  assert.deepEqual(state.fetchCalls.at(-1).body, { replacesBrowserId: 'old-private' });
  assert.deepEqual(state.runtimeMessages.at(-1), { type: 'pair-browser', code: 'ABCDEFGH2345' });
});

test('agent panel derives owner routes from a configured broker', async () => {
  const state = fixture({ local: { brokerUrl: 'https://bridge.example.com/work-edge/ingest' }, routes: [
    { ...signInRoute },
    { method: 'GET', path: '/work-edge/owner/agents', status: 200, body: listBody() }
  ] });
  await state.panel.ready;
  state.document.elements.ownerPassphrase.value = 'correct horse';
  await state.document.elements.ownerSignIn.trigger('click');
  assert.equal(state.fetchCalls[0].url, 'https://bridge.example.com/work-edge/owner/session');
  assert.match(state.document.elements.agentsSignedIn.snapshot(), /#agentsSignedIn/);
});
