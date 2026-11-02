import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Side panel Chat view shows the cockpit instead of a second chat (2026-10-22).
const { validCockpitUrl, createChatLoader } = await import('../extension/cockpit-panel.js');
const { registerInstallSetup } = await import('../extension/install-setup.js');
const { HOSTED_COCKPIT_URL } = await import('../extension/hosted-default.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('cockpit address must be HTTPS, or HTTP on localhost, with no embedded credentials', () => {
  assert.equal(validCockpitUrl('https://cockpit.example/'), 'https://cockpit.example/');
  assert.equal(validCockpitUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(validCockpitUrl('http://cockpit.example/'), null);
  assert.equal(validCockpitUrl('javascript:alert(1)'), null);
  assert.equal(validCockpitUrl('https://user:pass@cockpit.example/'), null);
  assert.equal(HOSTED_COCKPIT_URL, '');
});

test('side panel has a Chat view with the cockpit frame and keeps the full Bridge view', () => {
  const html = read('../extension/sidepanel.html');
  assert.match(html, /id="chatView"/);
  assert.match(html, /<iframe id="cockpitFrame"[^>]*allow="microphone; autoplay/);
  assert.match(html, /<main class="bridge" id="bridgeView"/);
  assert.match(html, /src="cockpit-panel\.js"/);
  // The popup stays a bridge-only surface.
  assert.doesNotMatch(read('../extension/popup.html'), /cockpitFrame|cockpit-panel/);
});

test('install opens setup in a tab, while update and reload do not', () => {
  let installed;
  const opened = [];
  registerInstallSetup({ runtime: { onInstalled: { addListener(fn) { installed = fn; } }, getURL: (path) => `chrome-extension://id/${path}` }, tabs: { create(tab) { opened.push(tab); } } });
  installed({ reason: 'update' });
  installed({ reason: 'chrome_update' });
  installed({ reason: 'install' });
  assert.deepEqual(opened, [{ url: 'chrome-extension://id/sidepanel.html?view=bridge&setup=1' }]);
});

test('setup puts pairing instructions and pairing card before other cards', () => {
  const html = read('../extension/sidepanel.html');
  assert.ok(html.indexOf('id="setupCard"') < html.indexOf('id="pairingCard"'));
  assert.ok(html.indexOf('id="pairingCard"') < html.indexOf('id="contextTitle"'));
  assert.match(html, /Pin this extension: click the puzzle-piece icon/);
  assert.match(html, /Manage agents \(owner sign-in\)/);
});

test('chat probe retries 2, 4, 8, then 15 seconds and loads when healthy', async () => {
  const listeners = {};
  const frame = { dataset: {}, src: '', addEventListener(type, fn) { listeners[type] = fn; } };
  const retryStatus = { hidden: true, textContent: '' };
  const pending = [];
  const fetchCalls = [];
  let now = 0;
  let fails = 0;
  const load = createChatLoader({ frame, retryStatus }, {
    fetch: async (url, options) => { fetchCalls.push([url, options]); return { status: fails++ < 4 ? 503 : 200 }; },
    setTimeout: (fn, delay) => { pending.push({ fn, delay }); return pending.length; },
    clearTimeout: () => {}, now: () => now
  });
  load('https://browser.example.com/');
  for (const delay of [2000, 4000, 8000, 15000]) {
    await new Promise((resolve) => setImmediate(resolve));
    const retry = pending.shift();
    assert.equal(retry.delay, delay);
    now += delay;
    retry.fn();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frame.src, 'https://browser.example.com/');
  assert.deepEqual(fetchCalls[0][1], { method: 'GET', cache: 'no-store', credentials: 'omit' });
  listeners.load();
  load('https://browser.example.com/');
  assert.equal(fetchCalls.length, 5);
  load('https://browser.example.com/', true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 6);
  assert.match(read('../extension/sidepanel.html'), /id="reloadChat"[^>]*>Reload chat/);
});
