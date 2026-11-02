import assert from 'node:assert/strict';
import test from 'node:test';

const worker = await import('../extension/service-worker.js');

function makeChrome({ frontUrl, requestedUrl, finalUrl, updateError = null, captureError = null }) {
  const listeners = [];
  const calls = { captures: 0, updates: [] };
  const tab = { id: 42, windowId: 7, title: 'Page', url: frontUrl, status: 'complete', active: true };

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
      tabs: {
        async query() { return [tab]; },
        async get(tabId) {
          assert.equal(tabId, tab.id);
          return { ...tab };
        },
        async update(tabId, values) {
          calls.updates.push({ tabId, values });
          assert.equal(tabId, tab.id);
          assert.equal(values.url, requestedUrl);
          if (finalUrl !== undefined) tab.url = finalUrl;
          tab.status = 'complete';
          queueMicrotask(() => listeners.slice().forEach((listener) => listener(tab.id, { status: 'complete' }, tab)));
          if (updateError) throw updateError;
          return { ...tab };
        },
        onUpdated: {
          addListener(listener) { listeners.push(listener); },
          removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
      },
      scripting: {
        async executeScript(options) {
          assert.equal(options.func?.name, 'capturePage');
          assert.deepEqual(options.args, [false]);
          calls.captures += 1;
          if (captureError) throw captureError;
          return [{ result: { title: tab.title, url: tab.url, text: 'Fresh page', elementSummary: [] } }];
        },
      },
    },
  };
}

async function navigateWith(chrome, url) {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    return await worker.executeCommandInActiveTab({ type: 'navigate', url });
  } finally {
    globalThis.chrome = originalChrome;
  }
}

test('navigation succeeds with capture when tabs.update rejects after the tab reaches the requested URL', async () => {
  const requestedUrl = 'https://example.com/report/';
  const chrome = makeChrome({
    frontUrl: 'https://example.com/start',
    requestedUrl,
    finalUrl: 'https://example.com/report',
    updateError: new Error('Navigation rejected.'),
  });

  const result = await navigateWith(chrome.api, requestedUrl);

  assert.equal(result.ok, true);
  assert.equal(result.result.navigated, true);
  assert.equal(result.result.capture.url, 'https://example.com');
  assert.equal(chrome.calls.captures, 1);
});

test('navigation returns a plain failure when tabs.update rejects and the tab stays elsewhere', async () => {
  const requestedUrl = 'https://example.com/report';
  const chrome = makeChrome({
    frontUrl: 'https://elsewhere.example/start',
    requestedUrl,
    finalUrl: 'https://elsewhere.example/start',
    updateError: new Error('Navigation rejected.'),
  });

  const result = await navigateWith(chrome.api, requestedUrl);

  assert.deepEqual(result, { ok: false, error: 'The browser did not open that page.' });
  assert.equal(chrome.calls.captures, 0);
});

test('navigation succeeds with capture after a same-origin redirect when tabs.update rejects', async () => {
  const requestedUrl = 'https://example.com/login';
  const chrome = makeChrome({
    frontUrl: 'https://example.com/start',
    requestedUrl,
    finalUrl: 'https://example.com/dashboard',
    updateError: new Error('Navigation rejected.'),
  });

  const result = await navigateWith(chrome.api, requestedUrl);

  assert.equal(result.ok, true);
  assert.equal(result.result.capture.url, 'https://example.com');
  assert.equal(chrome.calls.captures, 1);
});

test('normal navigation still waits for completion and captures the requested page', async () => {
  const requestedUrl = 'https://example.com/report';
  const chrome = makeChrome({
    frontUrl: 'https://example.com/start',
    requestedUrl,
    finalUrl: requestedUrl,
  });

  const result = await navigateWith(chrome.api, requestedUrl);

  assert.equal(result.ok, true);
  assert.equal(result.result.navigated, true);
  assert.equal(result.result.capture.text, 'Fresh page');
  assert.deepEqual(chrome.calls.updates, [{ tabId: 42, values: { url: requestedUrl } }]);
  assert.equal(chrome.calls.captures, 1);
});

test('navigation captures the origin where a redirect lands', async () => {
  const requestedUrl = 'https://search.example/query';
  const chrome = makeChrome({ frontUrl: 'https://start.example/', requestedUrl, finalUrl: 'https://consent.example/continue' });
  const result = await navigateWith(chrome.api, requestedUrl);
  assert.equal(result.ok, true);
  assert.equal(result.result.captureDelivered, false);
  assert.equal(result.result.capture.url, 'https://consent.example');
  assert.equal(result.result.page.address, 'https://consent.example/continue');
});

test('a failed capture after navigation still reports the navigation', async () => {
  const requestedUrl = 'https://example.com/report';
  const chrome = makeChrome({ frontUrl: 'https://example.com/start', requestedUrl, finalUrl: requestedUrl, captureError: new Error('Capture failed') });
  const result = await navigateWith(chrome.api, requestedUrl);
  assert.equal(result.ok, true);
  assert.equal(result.result.navigated, true);
  assert.equal(result.result.captureDelivered, false);
  assert.equal(result.result.captureError, 'Capture failed');
});

test('a rejected same-origin navigation that leaves the tab on its starting page is not reported as success', async () => {
  const requestedUrl = 'https://example.com/login';
  const chrome = makeChrome({
    frontUrl: 'https://example.com/start',
    requestedUrl,
    finalUrl: 'https://example.com/start',
    updateError: new Error('Navigation rejected.'),
  });

  const result = await navigateWith(chrome.api, requestedUrl);

  assert.deepEqual(result, { ok: false, error: 'The browser did not open that page.' });
  assert.equal(chrome.calls.captures, 0);
});
