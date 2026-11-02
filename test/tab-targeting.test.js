import assert from 'node:assert/strict';
import test from 'node:test';

// Tab targeting (approved by the owner in 2026-10-22): agents may read, act on, open,
// switch, and close any tab by explicit id, and work background tabs without
// disturbing the tab the user has in front.

const worker = await import('../extension/service-worker.js');
const { buildCommand } = await import('../broker/src/command-queue.js');
const { normalizeCapture } = await import('../broker/src/server.js');
const { ALL_TOOLS } = await import('../broker/src/tools.js');
const { canUseTool } = await import('../broker/src/agent-capabilities.js');

function makeChrome({ tabs, frontId, brokerUrl = 'https://broker.example/work-edge/ingest', closeOnGet = null, frameResults = null, sensitiveReadRestricted = false, approvedSensitiveReadOrigins = [], readEditableText = false }) {
  const byId = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const calls = { scripts: [], updates: [], creates: [], removes: [], windowFocus: [], visible: [], debugger: [], fetches: [] };
  const listeners = [];
  const sessionValues = { browserIdentity: { private: false } };
  let nextId = 900;
  let getCount = 0;
  const api = {
    storage: {
      local: {
        async get(keys) {
          const values = { hermesControlEnabled: true, brokerUrl, brokerToken: 'tok', approvedSensitiveReadOrigins, sensitiveReadRestricted, readMonitoringEnabled: false, readEditableText };
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
        },
        async set() {}
      },
      session: { async get(key) { return { [key]: sessionValues[key] }; }, async set(values) { Object.assign(sessionValues, values); }, async remove(key) { delete sessionValues[key]; } }
    },
    permissions: { async contains() { return true; } },
    runtime: { sendMessage() { return Promise.resolve(); } },
    tabs: {
      async query(options) {
        if (options.active && options.lastFocusedWindow) return byId.has(frontId) ? [byId.get(frontId)] : [];
        return [...byId.values()];
      },
      async get(id) {
        getCount += 1;
        if (closeOnGet !== null && getCount > closeOnGet) byId.delete(id);
        if (!byId.has(id)) throw new Error('No tab with id');
        return byId.get(id);
      },
      async update(id, values) {
        calls.updates.push({ id, values });
        const tab = byId.get(id);
        if (values.url) tab.url = values.url;
        if (values.active) frontId = id;
        queueMicrotask(() => listeners.slice().forEach((listener) => listener(id, { status: 'complete' })));
        return tab;
      },
      async create(values) {
        calls.creates.push(values);
        const tab = { id: nextId++, windowId: 11, url: values.url || 'chrome://newtab/', title: 'New', active: values.active, status: 'complete' };
        byId.set(tab.id, tab);
        if (values.active) frontId = tab.id;
        return tab;
      },
      async remove(id) { calls.removes.push(id); byId.delete(id); },
      async captureVisibleTab(windowId) { calls.visible.push(windowId); return 'data:image/png;base64,dmlzaWJsZQ=='; },
      onUpdated: {
        addListener(listener) { listeners.push(listener); },
        removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }
      }
    },
    windows: { async update(windowId, values) { calls.windowFocus.push({ windowId, values }); } },
    scripting: {
      async executeScript(options) {
        calls.scripts.push({ tabId: options.target.tabId, func: options.func?.name, allFrames: options.target.allFrames, ...(options.target.frameIds ? { frameIds: options.target.frameIds } : {}), ...(options.args ? { args: options.args } : {}) });
        const tab = byId.get(options.target.tabId);
        if (options.func?.name === 'capturePage') {
          const frames = frameResults || [{ frameId: 0, result: { title: tab?.title || 'Page', url: tab?.url, text: 'Background page text', elementSummary: [] } }];
          return options.target.frameIds ? frames.filter((frame) => options.target.frameIds.includes(frame.frameId)) : frames;
        }
        return [{ result: { ok: true, result: { acted: true } } }];
      }
    },
    debugger: {
      async attach(target) { calls.debugger.push(['attach', target.tabId]); },
      async sendCommand(target, method) { calls.debugger.push([method, target.tabId]); return { data: 'YmFja2dyb3VuZA==' }; },
      async detach(target) { calls.debugger.push(['detach', target.tabId]); }
    }
  };
  return { api, calls, byId, front: () => frontId };
}

async function withChrome(chrome, callback) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = chrome.api;
  globalThis.fetch = async (url, init) => { chrome.calls.fetches.push({ url: String(url), body: init?.body }); return { ok: true, status: 200, async json() { return {}; } }; };
  try { return await callback(); }
  finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
}

const FRONT = { id: 1, windowId: 11, url: 'https://chat.example/thread', title: 'My live work', active: true };
const BACKGROUND = { id: 2, windowId: 11, url: 'https://records.example/client?token=secret#x', title: 'Records', active: false };

test('extension consumes an exact single-click approval token once', async () => {
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1 });
  const binding = { token: 'single-use-test', transactionId: 'click-test', name: 'Send', fingerprint: 'abc12345',
    url: FRONT.url, title: FRONT.title, requestedUrl: null };
  const target = { selector: '#send' };
  await chrome.api.storage.session.set({ 'singleClick:single-use-test': { ...binding, target, tabId: 1, expiresAt: Date.now() + 1000 } });
  const command = { type: 'click', target, tabId: 1, finalAction: true, askBeforeFinalActions: true, approvalBinding: binding };
  const first = await withChrome(chrome, () => worker.executeCommandInActiveTab(command));
  assert.equal(first.ok, true);
  await chrome.api.storage.session.set({ 'singleClick:single-use-test': { ...binding, target, tabId: 1, expiresAt: Date.now() + 1000 } });
  chrome.byId.get(1).title = '(3) Inbox';
  chrome.byId.get(1).url = `${FRONT.url}?unread=3#message`;
  assert.equal((await withChrome(chrome, () => worker.executeCommandInActiveTab(command))).ok, true);
  await chrome.api.storage.session.set({ 'singleClick:single-use-test': { ...binding, target, tabId: 1, expiresAt: Date.now() + 1000 } });
  chrome.byId.get(1).url = 'https://chat.example/other-thread';
  assert.match((await withChrome(chrome, () => worker.executeCommandInActiveTab(command))).error, /page changed/);
  chrome.byId.get(1).url = FRONT.url;
  const count = chrome.calls.scripts.length;
  const reused = await withChrome(chrome, () => worker.executeCommandInActiveTab(command));
  assert.equal(reused.ok, false);
  assert.match(reused.error, /page changed/);
  assert.equal(chrome.calls.scripts.length, count);
  const missing = await withChrome(chrome, () => worker.executeCommandInActiveTab({ ...command, approvalBinding: undefined }));
  assert.equal(missing.ok, true);
  await chrome.api.storage.session.set({ 'singleClick:single-use-test': { ...binding, target, tabId: 1, expiresAt: Date.now() + 1000 } });
  const mismatched = await withChrome(chrome, () => worker.executeCommandInActiveTab({ ...command, target: { selector: '#other' } }));
  assert.match(mismatched.error, /page changed/);
});

test('a click on a named background tab runs there and never touches the front tab', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#open' }, tabId: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(chrome.calls.scripts.map((call) => call.tabId), [2]);
  assert.deepEqual(chrome.calls.updates, []);
  assert.deepEqual(chrome.calls.windowFocus, []);
  assert.equal(chrome.front(), 1);
});

test('a named tab that is gone is refused, never substituted', async () => {
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#open' }, tabId: 77 }));
  assert.equal(result.code, 'tab_not_found');
  assert.deepEqual(chrome.calls.scripts, []);
});

test('a named tab that closes before the action runs fails closed', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1, closeOnGet: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#open' }, tabId: 2 }));
  assert.equal(result.code, 'tab_changed');
  assert.deepEqual(chrome.calls.scripts, []);
});

test('listing returns every open tab, marks the front tab, and strips query strings', async () => {
  const internal = { id: 3, windowId: 12, url: 'chrome://newtab/', title: 'New Tab', active: true };
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND, internal], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'list_tabs' }));
  assert.equal(result.ok, true);
  assert.equal(result.result.frontTabId, 1);
  assert.deepEqual(result.result.tabs.map((tab) => tab.tabId), [1, 2, 3]);
  const background = result.result.tabs.find((tab) => tab.tabId === 2);
  assert.equal(background.address, 'https://records.example/client');
  assert.equal(background.front, false);
  assert.equal(result.result.tabs.find((tab) => tab.tabId === 3).readable, false);
});

test('reading a background tab captures it without switching', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'read_tab', tabId: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.result.tabId, 2);
  assert.equal(result.result.capture.text, 'Background page text');
  assert.deepEqual(chrome.calls.scripts.map((call) => call.tabId), [2]);
  assert.equal(chrome.front(), 1);
});

test('read_tab carries maxCharacters through the command and bounds its returned text', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const built = buildCommand('edge_read_tab', { tabId: 2, maxCharacters: 4 });
  assert.equal(built.command.maxCharacters, 4);
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab(built.command));
  assert.equal(result.result.capture.text, 'Back');
});

test('a new tab opens in the background by default and returns its id', async () => {
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'open_tab', url: 'https://docs.example/' }));
  assert.equal(result.ok, true);
  assert.equal(chrome.calls.creates[0].active, false);
  assert.equal(chrome.front(), 1);
  assert.equal(typeof result.result.tabId, 'number');
});

test('a new tab cannot open a final-action address', async () => {
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab(buildCommand('edge_open_tab', { url: 'https://shop.example/checkout' }).command));
  assert.equal(result.ok, false);
  assert.deepEqual(chrome.calls.creates, []);
});

test('navigate to a final-action URL still requires approval', async () => {
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1 });
  const command = buildCommand('edge_navigate', { url: 'https://shop.example/checkout' }).command;
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab(command));
  assert.match(result.error, /Approval required before opening this final-action URL/);
  assert.deepEqual(chrome.calls.updates, []);
  assert.deepEqual(chrome.calls.scripts, []);
});

test('activating a tab brings it and its window to the front', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'activate_tab', tabId: 2 }));
  assert.equal(result.ok, true);
  assert.equal(chrome.front(), 2);
  assert.deepEqual(chrome.calls.windowFocus, [{ windowId: 11, values: { focused: true } }]);
});

test('closing a tab removes only that tab', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'close_tab', tabId: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(chrome.calls.removes, [2]);
});

test('tab commands without a tabId are refused', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  for (const type of ['read_tab', 'activate_tab', 'close_tab']) {
    const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type }));
    assert.equal(result.code, 'tab_invalid', type);
  }
  assert.deepEqual(chrome.calls.removes, []);
});

test('navigating a background tab does not bring it to the front', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://records.example/next', tabId: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(chrome.calls.updates, [{ id: 2, values: { url: 'https://records.example/next' } }]);
  assert.equal(chrome.front(), 1);
});

test('a background tab screenshot uses the debugger and detaches; the front tab is not captured', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'screenshot', id: '0123456789abcdef', tabId: 2 }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.tabId, 2);
  assert.deepEqual(chrome.calls.visible, []);
  assert.deepEqual(chrome.calls.debugger, [['attach', 2], ['Page.captureScreenshot', 2], ['detach', 2]]);
  assert.equal(chrome.front(), 1);
});

test('broker builds tab commands and validates tab ids', () => {
  assert.equal(buildCommand('edge_click', { selector: '#a', tabId: 5 }).command.tabId, 5);
  assert.equal(buildCommand('edge_click', { selector: '#a' }).command.tabId, undefined);
  assert.match(buildCommand('edge_click', { selector: '#a', tabId: -1 }).error, /tabId/);
  assert.match(buildCommand('edge_click', { selector: '#a', tabId: '5' }).error, /tabId/);
  assert.match(buildCommand('edge_close_tab', {}).error, /requires a tabId/);
  assert.equal(buildCommand('edge_list_open_tabs', {}).command.type, 'list_tabs');
  assert.equal(buildCommand('edge_open_tab', { url: 'https://a.example/' }).command.active, false);
  assert.equal(buildCommand('edge_open_tab', { url: 'https://a.example/', active: true }).command.active, true);
  assert.equal(buildCommand('edge_open_tab', { url: 'https://shop.example/checkout' }).command.finalAction, true);
});

test('tab tools are published with the right capabilities and tab targeting', () => {
  const byName = Object.fromEntries(ALL_TOOLS.map((tool) => [tool.name, tool]));
  for (const name of ['edge_list_open_tabs', 'edge_read_tab']) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.equal(canUseTool({ capabilities: ['browser.read'] }, name), true, name);
  }
  for (const name of ['edge_open_tab', 'edge_activate_tab', 'edge_close_tab']) {
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.equal(canUseTool({ capabilities: ['browser.read'] }, name), false, name);
    assert.equal(canUseTool({ capabilities: ['browser.control'] }, name), true, name);
  }
  for (const name of ['edge_click', 'edge_type', 'edge_navigate', 'edge_screenshot', 'edge_find_elements']) {
    assert.ok(byName[name].inputSchema.properties.tabId, name);
  }
});

// --- Look before acting and per-tab snapshots (approved 2026-10-22) ---

const { SeenPages, pageAddress } = await import('../broker/src/seen-pages.js');

test('a click on a page the agent has not seen is refused with a fresh snapshot, and nothing is clicked', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#open' }, tabId: 2, agentId: 'agent-a', seenPages: {} }));
  assert.equal(result.code, 'look_first');
  assert.deepEqual(result.page, { tabId: 2, address: 'https://records.example/client' });
  assert.equal(result.capture.text, 'Background page text');
  // Only the capture script ran; no command executor was injected.
  assert.deepEqual(chrome.calls.scripts, [{ tabId: 2, func: 'capturePage', allFrames: true, args: [false] }]);
});

test('capture merges readable frames in document order and lists an unreadable frame', async () => {
  const frames = [
    { frameId: 0, result: { title: 'Page', url: FRONT.url, framePath: [], text: 'Top text', frameElements: [{ index: 0, url: 'https://child.example/first' }, { index: 1, url: 'https://private.example/blocked' }, { index: 2, url: 'https://child.example/last' }], elementSummary: [] } },
    { frameId: 7, result: { url: 'https://child.example/last', framePath: [2], text: 'Last text', frameElements: [], elementSummary: [] } },
    { frameId: 4, result: { url: 'https://child.example/first', framePath: [0], text: 'First text', frameElements: [], elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  const result = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.match(result.capture.text, /^Top text\n\[frame: https:\/\/child\.example\]\nFirst text\n\[unreadable frame: https:\/\/private\.example\]\n\[frame: https:\/\/child\.example\]\nLast text$/);
  assert.equal(result.capture.text_total_chars, result.capture.text.length);
  assert.equal(result.capture.truncated, false);
});

test('sensitive child frame needs its own approved origin', async () => {
  const frames = [
    { frameId: 0, result: { title: 'Page', url: FRONT.url, framePath: [], text: 'Normal page', frameElements: [{ index: 0, url: 'https://secure.example/account' }], elementSummary: [] } },
    { frameId: 3, result: { url: 'https://secure.example/account', framePath: [0], text: 'PRIVATE CHILD TEXT', frameElements: [], elementSummary: [], sensitiveSignals: ['account'] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames, sensitiveReadRestricted: true });
  const result = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.equal(result.needsApproval, true);
  assert.doesNotMatch(result.capture.text, /PRIVATE CHILD TEXT/);
  assert.match(result.capture.text, /sensitive frame: https:\/\/secure\.example/);
});

test('nested srcdoc text is merged under the parent origin without a src match', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://artifact.example/view' }], elementSummary: [] } },
    { frameId: 9, result: { url: 'about:srcdoc', framePath: [0, 0], text: 'Document body', frameElements: [], elementSummary: [] } },
    { frameId: 4, result: { url: 'https://artifact.example/view', framePath: [0], text: 'Artifact shell', frameElements: [{ index: 0, url: 'about:blank' }], elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  const result = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.match(result.capture.text, /^Top\n\[frame: https:\/\/artifact\.example\]\nArtifact shell\n\[frame: https:\/\/artifact\.example\]\nDocument body$/);
  assert.doesNotMatch(result.capture.text, /null|unreadable frame/);
});

test('editable setting is passed to every frame and a nested srcdoc read still obeys sensitive approval', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://artifact.example/view' }], elementSummary: [] } },
    { frameId: 4, result: { url: 'https://artifact.example/view', framePath: [0], text: 'Shell', frameElements: [{ index: 0, url: 'about:srcdoc' }], elementSummary: [] } },
    { frameId: 9, result: { url: 'about:srcdoc', framePath: [0, 0], text: 'Visible editable document', frameElements: [], elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames, readEditableText: true });
  const read = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'read_tab', tabId: 1 }));
  assert.match(read.result.capture.text, /Visible editable document/);
  assert.deepEqual(chrome.calls.scripts[0].args, [true]);
  assert.equal(chrome.calls.scripts[0].allFrames, true);

  const sensitiveFrames = frames.map((frame) => frame.frameId === 4
    ? { ...frame, result: { ...frame.result, url: 'https://artifact.example/account', sensitiveSignals: ['account'] } }
    : frame);
  const restricted = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: sensitiveFrames, readEditableText: true, sensitiveReadRestricted: true });
  const blocked = await withChrome(restricted, () => worker.captureTabForDelivery(FRONT, false));
  assert.equal(blocked.needsApproval, true);
  assert.doesNotMatch(blocked.capture.text, /Visible editable document/);
  assert.deepEqual(restricted.calls.scripts[0].args, [true]);
});

test('srcdoc under a sensitive parent requires the parent origin approval', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://secure.example/account' }], elementSummary: [] } },
    { frameId: 3, result: { url: 'https://secure.example/account', framePath: [0], text: 'Account page', frameElements: [{ index: 0, url: 'about:srcdoc' }], elementSummary: [], sensitiveSignals: ['account'] } },
    { frameId: 5, result: { url: 'about:srcdoc', framePath: [0, 0], text: 'PRIVATE DOCUMENT', elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames, sensitiveReadRestricted: true });
  const result = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.equal(result.needsApproval, true);
  assert.doesNotMatch(result.capture.text, /PRIVATE DOCUMENT|Account page/);
  assert.match(result.capture.text, /sensitive frame: https:\/\/secure\.example/);
});

test('top-level about:blank remains unreadable', async () => {
  const tab = { ...FRONT, url: 'about:blank' };
  const chrome = makeChrome({ tabs: [tab], frontId: 1 });
  await assert.rejects(withChrome(chrome, () => worker.captureTabForDelivery(tab, false)), /Browser-internal and file pages cannot be read/);
  assert.equal(chrome.calls.scripts.length, 0);
});

test('merged capture stops at 200k and reports the full text length', async () => {
  const frames = [{ frameId: 0, result: { title: 'Page', url: FRONT.url, text: 'Z'.repeat(200_000), text_total_chars: 220_000, elementSummary: [] } }];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  const result = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.equal(result.capture.text.length, 200_000);
  assert.equal(result.capture.text_total_chars, 220_000);
  assert.equal(result.capture.truncated, true);
});

test('live discovery creates a child-frame ref and click runs in that frame', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://child.example/panel' }], elementSummary: [] } },
    { frameId: 4, result: { url: 'https://child.example/panel', framePath: [0], text: 'Child', elementSummary: [{ tag: 'button', text: 'Open' }] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  const executeScript = chrome.api.scripting.executeScript;
  chrome.api.scripting.executeScript = async (options) => {
    if (options.args?.[0]?.type === 'find') {
      chrome.calls.scripts.push({ tabId: options.target.tabId, frameIds: options.target.frameIds, args: options.args });
      return [{ result: { ok: true, result: { selector: 'button', matches: [{ tag: 'button', text: 'Open', ref: 'work-edge-live-0' }] } } }];
    }
    return executeScript(options);
  };
  const capture = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.deepEqual(capture.rawCapture.elementSummary, [{ tag: 'button', text: 'Open', frameId: 4 }]);
  const found = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'find', selector: 'fbb-frame:4::button', seenPages: { 1: 'https://chat.example/thread' } }));
  assert.equal(found.ok, true, found.error);
  assert.equal(found.result.matches[0].ref, 'fbb-frame:4::work-edge-live-0');
  assert.deepEqual(chrome.calls.scripts.find((call) => call.args?.[0]?.type === 'find').frameIds, [4]);
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { ref: found.result.matches[0].ref }, seenPages: { 1: 'https://chat.example/thread' } }));
  assert.equal(result.ok, true, result.error);
  const action = chrome.calls.scripts.find((call) => call.args?.[0]?.type === 'click');
  assert.deepEqual(action.frameIds, [4]);
  assert.equal(action.args[0].target.ref, 'work-edge-live-0');
});

test('broker keeps passive frame IDs without adding form targets', () => {
  const policy = { allowOrigins: ['https://chat.example'], denyUrlPrefixes: [], capture: { maxTextCharacters: 200_000 } };
  const normalized = normalizeCapture({ tabId: 1, url: FRONT.url, text: 'Top', userInitiated: true, elementSummary: [{ tag: 'button', text: 'Open', frameId: 4 }] }, policy);
  assert.deepEqual(normalized.elementSummary, [{ tag: 'button', text: 'Open', frameId: 4 }]);
});

test('stale frame id fails clearly before an action executes', async () => {
  const frames = [{ frameId: 0, result: { title: FRONT.title, url: FRONT.url, text: 'Top', elementSummary: [] } }];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { ref: 'fbb-frame:99::work-edge-capture-abc-0' }, seenPages: { 1: 'https://chat.example/thread' } }));
  assert.equal(result.ok, false);
  assert.match(result.error, /Frame 99 is stale/);
  assert.equal(chrome.calls.scripts.some((call) => call.args?.[0]?.type === 'click'), false);
});

test('verified action locators stay in one captured frame', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://child.example/form' }], elementSummary: [] } },
    { frameId: 8, result: { url: 'https://child.example/form', framePath: [0], text: 'Form', elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames });
  await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  const scoped = 'fbb-frame:8::#field';
  const command = { type: 'verified_preflight', steps: [{ field: 'name', locator: { selector: scoped } }] };
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab(command));
  assert.equal(result.ok, true, result.error);
  const action = chrome.calls.scripts.find((call) => call.args?.[0]?.type === 'verified_preflight');
  assert.deepEqual(action.frameIds, [8]);
  assert.equal(action.args[0].steps[0].locator.selector, '#field');
  const mixed = await withChrome(chrome, () => worker.executeCommandInActiveTab({ ...command, commit: { selector: '#save' } }));
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /one frame/);
});

test('sensitive child frame does not expose target refs without approval', async () => {
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://secure.example/account' }], elementSummary: [] } },
    { frameId: 3, result: { url: 'https://secure.example/account', framePath: [0], text: 'Private', sensitiveSignals: ['account'], elementSummary: [{ tag: 'button', text: 'Secret', ref: 'work-edge-capture-abc-0' }] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames, sensitiveReadRestricted: true });
  const capture = await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  assert.equal(capture.rawCapture.elementSummary.length, 0);
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'find', selector: 'fbb-frame:3::button' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /Frame 3 is stale/);
});

test('live discovery in a captured sensitive child checks its own origin', async () => {
  const approved = ['https://secure.example'];
  const frames = [
    { frameId: 0, result: { title: FRONT.title, url: FRONT.url, framePath: [], text: 'Top', frameElements: [{ index: 0, url: 'https://secure.example/account' }], elementSummary: [] } },
    { frameId: 3, result: { url: 'https://secure.example/account', framePath: [0], text: 'Private', sensitiveSignals: ['account'], elementSummary: [] } }
  ];
  const chrome = makeChrome({ tabs: [FRONT], frontId: 1, frameResults: frames, sensitiveReadRestricted: true, approvedSensitiveReadOrigins: approved });
  await withChrome(chrome, () => worker.captureTabForDelivery(FRONT, false));
  approved.length = 0;
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'find', selector: 'fbb-frame:3::button' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /sensitive frame requires sensitive-read approval/);
});

test('a click proceeds when the agent has seen the current page, and returns a fresh after-read', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#open' }, tabId: 2, agentId: 'agent-a', seenPages: { 2: 'https://records.example/client' } }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result.page, { tabId: 2, address: 'https://records.example/client' });
  assert.equal(result.result.capture.text, 'Background page text');
});

test('a page that moved since the agent looked is refused', async () => {
  const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
  const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'type', target: { selector: '#q' }, text: 'x', tabId: 2, agentId: 'agent-a', seenPages: { 2: 'https://records.example/other-page' } }));
  assert.equal(result.code, 'look_first');
});

test('scroll, wait, and navigate do not require a prior look', async () => {
  for (const command of [{ type: 'scroll', direction: 'down' }, { type: 'wait', ms: 1 }]) {
    const chrome = makeChrome({ tabs: [FRONT, BACKGROUND], frontId: 1 });
    const result = await withChrome(chrome, () => worker.executeCommandInActiveTab({ ...command, tabId: 2, agentId: 'agent-a', seenPages: {} }));
    assert.notEqual(result.code, 'look_first', command.type);
  }
});

test('the broker tracks seen pages per agent and per tab, and strips query strings', () => {
  const seen = new SeenPages();
  assert.equal(pageAddress('https://a.example/x?token=1#y'), 'https://a.example/x');
  seen.record('agent-a', 'digest', 2, 'https://a.example/x?token=1');
  seen.recordPage('agent-a', 'digest', { tabId: 3, address: 'https://b.example/' });
  assert.deepEqual(seen.forAgent('agent-a', 'digest'), { 2: 'https://a.example/x', 3: 'https://b.example/' });
  assert.deepEqual(seen.forAgent('agent-b', 'digest'), {});
  seen.forgetAgent('agent-a');
  assert.deepEqual(seen.forAgent('agent-a', 'digest'), {});
});

test('the look-first address matches between broker and extension', async () => {
  const chrome = makeChrome({ tabs: [BACKGROUND], frontId: 2 });
  const listed = await withChrome(chrome, () => worker.executeCommandInActiveTab({ type: 'list_tabs' }));
  assert.equal(listed.result.tabs[0].address, pageAddress(BACKGROUND.url));
});

test('snapshot and text tools accept a tab id', () => {
  const byName = Object.fromEntries(ALL_TOOLS.map((tool) => [tool.name, tool]));
  assert.ok(byName.edge_snapshot.inputSchema.properties.tabId);
  assert.ok(byName.edge_extract_text.inputSchema.properties.tabId);
});

test('read tools allow a 60k-character request', () => {
  const byName = Object.fromEntries(ALL_TOOLS.map((tool) => [tool.name, tool]));
  assert.ok(byName.edge_extract_text.inputSchema.properties.maxCharacters.maximum >= 60_000);
  assert.ok(byName.edge_read_tab.inputSchema.properties.maxCharacters.maximum >= 60_000);
});
