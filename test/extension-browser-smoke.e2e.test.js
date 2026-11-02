import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';

const enabled = process.env.WORK_EDGE_BROWSER_E2E === '1';
const timeoutMs = 10_000;
const authDiagnostic = 'Chrome/CDP environment blocks authenticated extension smoke: popup.html resolves to chrome-error://chromewebdata/ (content verification failed) and chrome.storage is unavailable in the extension service worker; storage cannot be safely seeded.';
const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['https://approved.example'],
  denyUrlPrefixes: ['edge://', 'chrome://', 'file://', 'about:'],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includePayloadContent: false, includeUrlPath: false }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(read, description, deadlineMs = timeoutMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, body: await response.json() };
  } finally { clearTimeout(timer); }
}

async function start(server, t) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function bridgeIsOnline(base) {
  const { body } = await fetchJson(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bridge-status', method: 'tools/call', params: { name: 'edge_bridge_status', arguments: {} } }) });
  return JSON.parse(body.result.content[0].text).recentCommandPolling === true;
}

async function cdpEvaluate(debuggerUrl, expression) {
  const socket = new WebSocket(debuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 2_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed to open')); }, { once: true });
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 3_000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) { clearTimeout(timer); resolve(message); }
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (response.error || response.result?.exceptionDetails) throw new Error(`CDP evaluation failed: ${JSON.stringify(response.error || response.result.exceptionDetails)}`);
    return response.result?.result?.value;
  } finally { socket.close(); }
}

async function launchChrome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-browser-e2e-'));
  const profile = join(directory, 'chrome-profile');
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--disable-extensions-except=${resolve('extension')}`, `--load-extension=${resolve('extension')}`, 'about:blank'], { stdio: 'pipe' });
  let stderr = '';
  chrome.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  t.after(async () => {
    if (chrome.exitCode === null && !chrome.killed) chrome.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => chrome.once('close', resolve)),
      delay(1_000)
    ]).catch(() => {});
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const debugPort = await eventually(() => {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}; stderr: ${stderr || '(none)'}`);
    const activePort = join(profile, 'DevToolsActivePort');
    if (!existsSync(activePort)) return null;
    const port = Number(readFileSync(activePort, 'utf8').split('\n')[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  }, 'Chrome did not create DevToolsActivePort');
  const worker = await eventually(async () => {
    const { body: targets } = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    return targets.find((entry) => entry.type === 'service_worker' && /\/service[-_]worker\.js$/.test(entry.url));
  }, `extension service worker did not appear in Chrome debugger targets; Chrome stderr: ${stderr || '(none)'}`);
  return { debugPort, worker, stderr: () => stderr };
}

function assertManifestWorker(worker) {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.match(worker.url, /^chrome-extension:\/\/[^/]+\/service[-_]worker\.js$/, 'Chrome must load the manifest-declared MV3 service worker');
  assert.ok(worker.webSocketDebuggerUrl, 'service worker must be inspectable through CDP');
}

test('Chrome loads the manifest-declared extension service worker', { skip: !enabled }, async (t) => {
  if (spawnSync('sh', ['-c', 'command -v google-chrome'], { stdio: 'ignore' }).status !== 0) t.skip('google-chrome is required for this opt-in smoke test.');
  assertManifestWorker((await launchChrome(t)).worker);
});

test('authenticated extension browser bridge smoke', { skip: !enabled }, async (t) => {
  if (spawnSync('sh', ['-c', 'command -v google-chrome'], { stdio: 'ignore' }).status !== 0) t.skip('google-chrome is required for this opt-in smoke test.');
  const chrome = await launchChrome(t);
  assertManifestWorker(chrome.worker);
  const extensionId = chrome.worker.url.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
  assert.ok(extensionId, 'service worker URL must include an extension id');
  const { body: popupTarget } = await fetchJson(`http://127.0.0.1:${chrome.debugPort}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, { method: 'PUT' });
  const popupUrl = await cdpEvaluate(popupTarget.webSocketDebuggerUrl, 'location.href').catch(() => null);
  const popupStorage = await cdpEvaluate(popupTarget.webSocketDebuggerUrl, 'Boolean(globalThis.chrome?.storage?.local)').catch(() => false);
  const workerStorage = await cdpEvaluate(chrome.worker.webSocketDebuggerUrl, 'Boolean(globalThis.chrome?.storage?.local)').catch(() => false);
  if (popupUrl === 'chrome-error://chromewebdata/' && !workerStorage) return t.skip(authDiagnostic);
  if (!popupStorage || !workerStorage) throw new Error(`Extension storage is unavailable without the known content-verification signature (popup=${popupUrl || 'uninspectable'}, popupStorage=${popupStorage}, workerStorage=${workerStorage}); Chrome stderr: ${chrome.stderr() || '(none)'}`);

  const directory = mkdtempSync(join(tmpdir(), 'work-edge-browser-broker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'browser-e2e-token';
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(token);
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'command-state.json') });
  const base = await start(createServer({ policy, tokenStore, commandQueue: queue }), t);
  const seed = JSON.stringify({ brokerUrl: `${base}/ingest`, brokerToken: token });
  assert.equal(await cdpEvaluate(popupTarget.webSocketDebuggerUrl, `new Promise((resolve) => chrome.storage.local.set(${seed}, () => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'ok')))`), 'ok');
  const toggleResult = await cdpEvaluate(popupTarget.webSocketDebuggerUrl, "new Promise((resolve) => chrome.runtime.sendMessage({ type: 'toggle-browser-control' }, resolve))");
  assert.equal(toggleResult?.enabled, true, `extension failed to enable its broker transport: ${JSON.stringify(toggleResult)}`);
  await eventually(() => bridgeIsOnline(base), `extension did not authenticate its WebSocket with the local broker; Chrome stderr: ${chrome.stderr() || '(none)'}`);
});
