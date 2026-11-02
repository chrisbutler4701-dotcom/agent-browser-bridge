import assert from 'node:assert/strict';
import test from 'node:test';

const worker = await import('../extension/service-worker.js');

function makeChrome({ front, background = null, controlEnabled = true }) {
  const updates = [];
  const scriptTargets = [];
  const listeners = [];
  const normalTabs = [front, background].filter(Boolean);
  return {
    updates,
    scriptTargets,
    api: {
      storage: {
        local: {
          async get(keys) {
            const values = { hermesControlEnabled: controlEnabled, brokerUrl: '', brokerToken: '', approvedSensitiveReadOrigins: [], sensitiveReadRestricted: false };
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
          },
          async set() {},
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      tabs: {
        async query(options) {
          if (options.windowType === 'normal') return normalTabs;
          if (options.active) return [front];
          return [];
        },
        async update(tabId, values) {
          updates.push({ tabId, values });
          front.url = values.url;
          queueMicrotask(() => listeners.slice().forEach((listener) => listener(tabId, { status: 'complete' }, front)));
          return front;
        },
        onUpdated: {
          addListener(listener) { listeners.push(listener); },
          removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
        },
      },
      scripting: {
        async executeScript(options) {
          scriptTargets.push(options.target.tabId);
          if (options.func?.name === 'capturePage') return [{ result: { title: 'Captured page', url: normalTabs.find((tab) => tab.id === options.target.tabId)?.url, text: 'Safe page', elementSummary: [] } }];
          return [{ result: { ok: true, result: { clicked: true } } }];
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

test('navigate moves the empty front tab and never the background web tab', async () => {
  const front = { id: 11, url: 'chrome://newtab/', active: true, lastAccessed: 20 };
  const background = { id: 22, url: 'https://background.example/', active: false, lastAccessed: 10 };
  const chrome = makeChrome({ front, background });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://example.com/next' }));
  assert.equal(result.ok, true);
  assert.deepEqual(chrome.updates, [{ tabId: 11, values: { url: 'https://example.com/next' } }]);
  assert.equal(background.url, 'https://background.example/');
});

test('navigate from a non-empty internal front tab remains refused', async () => {
  const chrome = makeChrome({ front: { id: 11, url: 'chrome://settings/', active: true } });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://example.com/' }));
  assert.deepEqual(result, { ok: false, error: "Your front tab isn't a normal web page, so nothing was done. Switch to the page you want and try again." });
  assert.deepEqual(chrome.updates, []);
});

test('non-navigate commands refuse an empty front tab instead of using a background tab', async () => {
  const front = { id: 11, url: 'about:blank', active: true, lastAccessed: 20 };
  const background = { id: 22, url: 'https://background.example/', active: false, lastAccessed: 10 };
  const chrome = makeChrome({ front, background });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'click', target: { selector: '#safe' } }));
  assert.deepEqual(result, { ok: false, error: "Your front tab isn't a normal web page, so nothing was done. Switch to the page you want and try again." });
  assert.deepEqual(chrome.scriptTargets, []);
  assert.deepEqual(chrome.updates, []);
});

test('empty-tab navigate refuses non-HTTP targets', async () => {
  for (const url of ['file:///etc/passwd', 'chrome://settings']) {
    const chrome = makeChrome({ front: { id: 11, url: '', active: true } });
    const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url }));
    assert.match(result.error, /Refused: remote navigation is limited to normal URLs/);
    assert.deepEqual(chrome.updates, []);
  }
});

test('control-disabled refusal happens before the empty-tab exception', async () => {
  const chrome = makeChrome({ front: { id: 11, url: 'about:blank', active: true }, controlEnabled: false });
  const result = await withChrome(chrome.api, () => worker.executeCommandInActiveTab({ type: 'navigate', url: 'https://example.com/' }));
  assert.deepEqual(result, { ok: false, error: 'Control is not enabled.' });
  assert.deepEqual(chrome.updates, []);
});

test('isEmptyTabUrl recognizes only approved empty and new-tab URLs', () => {
  assert.equal(typeof worker.isEmptyTabUrl, 'function');
  for (const url of ['', null, undefined, 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']) assert.equal(worker.isEmptyTabUrl(url), true, String(url));
  for (const url of ['about:srcdoc', 'chrome://settings', 'https://x']) assert.equal(worker.isEmptyTabUrl(url), false, url);
});
