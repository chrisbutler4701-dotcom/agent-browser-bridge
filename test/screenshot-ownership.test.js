import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { screenshotActiveTab } from '../extension/service-worker.js';

const COMMAND = { id: '0123456789abcdef', type: 'screenshot' };
const TAB = { id: 1, windowId: 11, url: 'https://example.com/private/path', active: true };
const TAB_CHANGED = {
  ok: false,
  code: 'tab_changed',
  error: 'The front tab changed before the action ran, so nothing was done.'
};

function makeChrome({ foregroundQueries = [TAB, TAB], capture }) {
  const calls = { captures: [], fetches: [] };
  let queryIndex = 0;
  return {
    calls,
    api: {
      storage: {
        local: {
          async get(keys) {
            const values = {
              hermesControlEnabled: true,
              sensitiveReadRestricted: false,
              approvedSensitiveReadOrigins: [],
              brokerUrl: 'http://127.0.0.1:8765',
              brokerToken: 'paired-token'
            };
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
          }
        }
      },
      permissions: { async contains() { return true; } },
      tabs: {
        async query(options) {
          assert.deepEqual(options, { active: true, lastFocusedWindow: true });
          return [foregroundQueries[queryIndex++] ?? foregroundQueries.at(-1)];
        },
        async captureVisibleTab(windowId, options) {
          calls.captures.push({ windowId, options });
          return capture();
        }
      }
    },
    fetch: async (url, options) => {
      calls.fetches.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true };
    }
  };
}

async function runWith(chrome, callback) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = chrome.api;
  globalThis.fetch = chrome.fetch;
  try { return await callback(); }
  finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
}

test('capture failure refuses the screenshot and never captures another window', async () => {
  const chrome = makeChrome({ capture() { throw new Error('capture failed'); } });
  const result = await runWith(chrome, () => screenshotActiveTab(TAB, COMMAND));

  assert.deepEqual(result, {
    ok: false,
    code: 'screenshot_unavailable',
    error: 'The screenshot could not be taken of your front tab, so none was returned.'
  });
  assert.deepEqual(chrome.calls.captures, [{ windowId: 11, options: { format: 'png' } }]);
  assert.deepEqual(chrome.calls.fetches, []);
});

test('a tab switch before capture is refused without capturing or delivering an image', async () => {
  const otherTab = { id: 2, windowId: 11, url: 'https://other.example/', active: true };
  const chrome = makeChrome({ foregroundQueries: [otherTab], capture() { throw new Error('must not capture'); } });
  const result = await runWith(chrome, () => screenshotActiveTab(TAB, COMMAND));

  assert.deepEqual(result, TAB_CHANGED);
  assert.deepEqual(chrome.calls.captures, []);
  assert.deepEqual(chrome.calls.fetches, []);
});

test('a tab switch immediately after capture discards the image', async () => {
  const otherTab = { id: 2, windowId: 11, url: 'https://other.example/', active: true };
  const chrome = makeChrome({ foregroundQueries: [TAB, otherTab], capture: () => 'data:image/png;base64,iVBORw0KGgo=' });
  const result = await runWith(chrome, () => screenshotActiveTab(TAB, COMMAND));

  assert.deepEqual(result, TAB_CHANGED);
  assert.deepEqual(chrome.calls.captures, [{ windowId: 11, options: { format: 'png' } }]);
  assert.deepEqual(chrome.calls.fetches, []);
});

test('a screenshot reports the proven foreground tab, window, origin, and capture time', async () => {
  const chrome = makeChrome({ capture: () => 'data:image/png;base64,iVBORw0KGgo=' });
  const result = await runWith(chrome, () => screenshotActiveTab(TAB, COMMAND));

  assert.equal(result.ok, true);
  assert.deepEqual(
    { ...result.result, capturedAt: '<timestamp>' },
    { tabId: 1, windowId: 11, origin: 'https://example.com', capturedAt: '<timestamp>', mimeType: 'image/png', screenshotDelivered: true }
  );
  assert.equal(Number.isNaN(Date.parse(result.result.capturedAt)), false);
  assert.equal(chrome.calls.fetches.length, 1);
});

test('extension screenshot source has no undefined-window or recent-image fallback', () => {
  const readSourceTree = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return readSourceTree(url);
    return /\.(?:css|html|js|json)$/.test(entry.name) ? [readFileSync(url, 'utf8')] : [];
  });
  const source = readSourceTree(new URL('../extension/', import.meta.url)).join('\n');
  assert.doesNotMatch(source, /captureVisibleTab\(undefined/);
  assert.doesNotMatch(source, /recentScreenshotCache/);
});
