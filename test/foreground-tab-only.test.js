import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const worker = await import('../extension/service-worker.js');

const REFUSAL = "Your front tab isn't a normal web page, so nothing was done. Switch to the page you want and try again.";

function makeChrome({ front, background = null, foregroundQueries = null }) {
  const calls = { messages: [], updates: [], scripts: [], screenshots: [] };
  const listeners = [];
  let queryIndex = 0;
  let currentFront = front;

  return {
    calls,
    api: {
      storage: {
        local: {
          async get(keys) {
            const values = { hermesControlEnabled: true, brokerUrl: '', brokerToken: '', approvedSensitiveReadOrigins: [], sensitiveReadRestricted: false };
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
          },
          async set() {},
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      permissions: { async contains() { return true; } },
      tabs: {
        async query(options) {
          if (options.active && options.lastFocusedWindow) {
            currentFront = foregroundQueries?.[queryIndex++] ?? currentFront;
            return currentFront ? [currentFront] : [];
          }
          if (options.windowType === 'normal') return [currentFront, background].filter(Boolean);
          if (options.active) return currentFront ? [currentFront] : [];
          return [];
        },
        async sendMessage(tabId, message) {
          calls.messages.push({ tabId, message });
          return { ok: true };
        },
        async update(tabId, values) {
          calls.updates.push({ tabId, values });
          if (currentFront?.id === tabId) currentFront = { ...currentFront, url: values.url };
          queueMicrotask(() => listeners.slice().forEach((listener) => listener(tabId, { status: 'complete' }, currentFront)));
          return currentFront;
        },
        async captureVisibleTab(windowId, options) {
          calls.screenshots.push({ windowId, options });
          return 'data:image/png;base64,cGl4ZWw=';
        },
        onUpdated: {
          addListener(listener) { listeners.push(listener); },
          removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
        },
      },
      scripting: {
        async executeScript(options) {
          calls.scripts.push({ tabId: options.target.tabId, files: options.files });
          if (options.func?.name === 'capturePage') {
            const selected = [currentFront, background].find((tab) => tab?.id === options.target.tabId);
            return [{ result: { title: 'Captured page', url: selected?.url, text: 'Safe page', elementSummary: [] } }];
          }
          return [{ result: { ok: true, result: { acted: true } } }];
        },
      },
    },
  };
}

async function withChrome(chrome, callback) {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  try { return await callback(); }
  finally { globalThis.chrome = originalChrome; }
}

test('commands refuse an internal foreground tab without touching a background web tab', async () => {
  const commands = [
    { type: 'click', target: { selector: '#pay' } },
    { type: 'type', target: { selector: '#amount' }, text: '10' },
    { type: 'select', target: { selector: '#account' }, value: 'checking' },
    { type: 'press', key: 'Enter' },
    { type: 'scroll', direction: 'down' },
    { type: 'find', scope: 'live', query: 'Balance' },
    { type: 'wait', durationMs: 1 },
    { type: 'screenshot', id: '0123456789abcdef' },
  ];

  for (const command of commands) {
    const front = { id: 1, windowId: 11, url: 'chrome://newtab/', active: true };
    const background = { id: 2, windowId: 22, url: 'https://bank.example/', active: false, lastAccessed: 100 };
    const chrome = makeChrome({ front, background });
    const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab(command));

    assert.deepEqual(result, { ok: false, error: REFUSAL }, command.type);
    assert.deepEqual(chrome.calls, { messages: [], updates: [], scripts: [], screenshots: [] }, command.type);
  }
});

test('a foreground tab switch before an action fails closed', async () => {
  const first = { id: 1, windowId: 11, url: 'https://a.example/', active: true };
  const second = { id: 3, windowId: 11, url: 'https://b.example/', active: true };
  const chrome = makeChrome({ front: first, foregroundQueries: [first, second] });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#go' } }));

  assert.deepEqual(result, { ok: false, code: 'tab_changed', error: 'The front tab changed before the action ran, so nothing was done.' });
  assert.deepEqual(chrome.calls, { messages: [], updates: [], scripts: [], screenshots: [] });
});

test('a verified action whose expected tab is no longer foreground is refused without messaging either tab', async () => {
  const foreground = { id: 2, windowId: 11, url: 'https://approved.example/', active: true };
  const expected = { id: 1, windowId: 11, url: 'https://approved.example/', active: false };
  const chrome = makeChrome({ front: foreground, background: expected });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({
    type: 'verified_preflight',
    expectedTabId: 1,
    expectedOrigin: 'https://approved.example',
    steps: []
  }));

  assert.deepEqual(result, { ok: false, error: 'The active tab no longer matches the approved verified-action target.' });
  assert.deepEqual(chrome.calls.messages, []);
  assert.deepEqual(chrome.calls.scripts, []);
});

test('navigate updates only the same empty foreground tab', async () => {
  const front = { id: 1, windowId: 11, url: 'chrome://newtab/', active: true };
  const background = { id: 2, windowId: 22, url: 'https://bank.example/', active: false };
  const chrome = makeChrome({ front, background });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://example.com/' }));

  assert.equal(result.ok, true);
  assert.deepEqual(chrome.calls.updates, [{ tabId: 1, values: { url: 'https://example.com/' } }]);
  assert.equal(chrome.calls.updates.some(({ tabId }) => tabId === 2), false);
});

test('navigate refuses when the empty foreground tab changes before update', async () => {
  const first = { id: 1, windowId: 11, url: 'chrome://newtab/', active: true };
  const second = { id: 3, windowId: 11, url: 'chrome://newtab/', active: true };
  const chrome = makeChrome({ front: first, foregroundQueries: [first, second] });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://example.com/' }));

  assert.deepEqual(result, { ok: false, code: 'tab_changed', error: 'The front tab changed before the action ran, so nothing was done.' });
  assert.deepEqual(chrome.calls.updates, []);
});

test('a devtools tab in the last-focused window is refused', async () => {
  const chrome = makeChrome({ front: { id: 4, windowId: 44, url: 'devtools://devtools/bundled/inspector.html', active: true } });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#go' } }));

  assert.deepEqual(result, { ok: false, error: REFUSAL });
  assert.deepEqual(chrome.calls, { messages: [], updates: [], scripts: [], screenshots: [] });
});

test('activeTab has no hidden-tab fallback query or lastAccessed sorting', () => {
  const source = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const activeTabSource = source.slice(source.indexOf('async function activeTab()'), source.indexOf('\n}', source.indexOf('async function activeTab()')) + 2);
  assert.doesNotMatch(activeTabSource, /lastAccessed/);
  assert.doesNotMatch(activeTabSource, /chrome\.tabs\.query\(\{ active: true \}\)/);
  assert.doesNotMatch(activeTabSource, /currentWindow|windowType/);
  assert.match(activeTabSource, /chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/);
});
