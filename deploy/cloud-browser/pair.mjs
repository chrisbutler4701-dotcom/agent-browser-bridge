import { chromium } from 'playwright-core';

const server = process.env.FBB_SERVER;
const code = process.env.FBB_PAIR_CODE || '';
// Agents act only on a normal web tab, so leave one in front after pairing.
const startUrl = process.env.FBB_CLOUD_START_URL || 'https://www.iana.org/';
if (!server) throw new Error('FBB_SERVER is required.');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:9222'); }
    catch (error) { lastError = error; await delay(500); }
  }
  throw lastError || new Error('Chromium CDP endpoint did not become ready.');
}

const browser = await connect();
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chromium did not expose a browser context.');
  const sandboxPage = await context.newPage();
  try {
    if (process.env.FBB_CLOUD_NO_SANDBOX === '1' && process.env.FBB_ENV === 'development') {
      process.stderr.write('WARNING: CHROMIUM SANDBOX VERIFICATION SKIPPED FOR DEVELOPMENT.\n');
    } else {
      await sandboxPage.goto('chrome://sandbox');
      const sandboxStatus = await sandboxPage.evaluate(() => document.body.innerText);
      if (!/You are adequately sandboxed/i.test(sandboxStatus)) {
        throw new Error('Chromium sandbox is not active; refusing to start.');
      }
    }
  } finally {
    await sandboxPage.close();
  }
  let worker;
  for (let attempt = 0; attempt < 60 && !worker; attempt += 1) {
    worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
    if (!worker) await Promise.race([context.waitForEvent('serviceworker').catch(() => null), delay(500)]);
  }
  if (!worker) throw new Error('Field Browser Bridge extension service worker did not start.');
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  let status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'broker-status' }));
  if (!status?.paired) {
    if (!code) throw new Error('FBB_PAIR_CODE is required for the first cloud-browser start.');
    const paired = await page.evaluate(({ brokerUrl, pairingCode }) => chrome.runtime.sendMessage({ type: 'pair-browser', brokerUrl, code: pairingCode }), { brokerUrl: server, pairingCode: code });
    if (!paired?.ok) throw new Error(paired?.error || 'Cloud browser pairing failed.');
    status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'broker-status' }));
  }
  if (!status.controlEnabled) {
    const toggled = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'toggle-browser-control' }));
    if (!toggled?.ok || toggled.enabled !== true) throw new Error(toggled?.error || 'Cloud browser control could not be enabled.');
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'broker-status' }));
    if (status?.paired && status.controlEnabled && status.pollHeartbeat?.diagnostic === 'websocket_active') {
      process.stdout.write('Cloud browser paired; browser control is on and WebSocket transport is active.\n');
      process.exitCode = 0;
      break;
    }
    await delay(500);
  }
  if (!status?.paired || !status.controlEnabled || status.pollHeartbeat?.diagnostic !== 'websocket_active') throw new Error('Cloud browser did not reach paired, control-on, websocket-active status.');
  await page.close();
  const tab = context.pages().find((candidate) => /^https?:/u.test(candidate.url())) || context.pages()[0] || await context.newPage();
  if (!/^https?:/u.test(tab.url())) await tab.goto(startUrl);
  await tab.bringToFront();
  process.stdout.write(`Cloud browser ready on a normal web tab: ${new URL(tab.url()).origin}\n`);
} finally {
  await browser.close();
}
