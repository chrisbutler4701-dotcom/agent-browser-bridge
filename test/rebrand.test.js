import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { websocketEndpointUrl } from '../extension/broker-url.js';
import { HOSTED_INGEST_URL } from '../extension/hosted-default.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('package and extension expose the Field Browser Bridge identity', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const manifest = JSON.parse(read('../extension/manifest.json'));
  assert.equal(packageJson.name, 'field-browser-bridge');
  assert.equal(packageJson.version, '1.5.0');
  assert.equal(packageJson.engines.node, '>=22.12');
  assert.equal(manifest.name, 'Field Browser Bridge');
  assert.equal(manifest.action.default_title, 'Field Browser Bridge');
  assert.equal(manifest.version, '1.5.0');
});

test('extension source has no hosted Field Browser Bridge server default', () => {
  assert.equal(HOSTED_INGEST_URL, '');
  assert.equal(websocketEndpointUrl(HOSTED_INGEST_URL), null);
  assert.doesNotMatch(read('../extension/manifest.json'), /old-browser\.example\.com/);
});

test('side panel is a bridge control surface without Hermes chat', () => {
  const html = read('../extension/sidepanel.html');
  const worker = read('../extension/service-worker.js');
  const server = read('../broker/src/server.js');
  assert.match(html, /Talk to Claude or ChatGPT in their apps; they act on this browser through Field Browser Bridge\./);
  assert.doesNotMatch(html, /chat-input|send-btn|Telegram|Kokoro|Hermes/i);
  assert.doesNotMatch(worker, /send-chat|chat-history|synthesize-speech|Kokoro/i);
  assert.doesNotMatch(server, /work-edge\/chat|createHermes|HermesContinuity|node:child_process|node:sqlite/);
  assert.match(html, /id="agentsCard"/);
  assert.match(html, /src="agents-panel\.js"/);
  assert.match(html, /<label for="ownerPassphrase">Owner passphrase<\/label>/);
  assert.doesNotMatch(html, /Sign in with your server passphrase to manage agents\./);
});

test('toolbar icon opens the side panel', () => {
  const manifest = JSON.parse(read('../extension/manifest.json'));
  const worker = read('../extension/service-worker.js');
  assert.equal(manifest.action.default_popup, undefined);
  assert.match(worker, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
});
