import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { scrub, restore } from '../extension/swap.js';

const source = (name) => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const roster = JSON.parse(readFileSync(new URL('../test-fixtures/roster.json', import.meta.url)));

test('fixture PDF extracts all three made-up clients and uploads only scrubbed text', async () => {
  const original = readFileSync(new URL('../test-fixtures/made-up-clients.pdf', import.meta.url));
  const text = [...original.toString('latin1').matchAll(/\(([^()]*)\) Tj/gu)].map((match) => match[1]).join(' ');
  for (const client of roster) assert.ok(text.includes(client.name));
  const map = {};
  const result = scrub(text, roster, map);
  const body = new TextEncoder().encode(result.text);
  assert.ok(result.replaced.length >= 3);
  for (const client of roster) assert.ok(!new TextDecoder().decode(body).includes(client.name));
  assert.ok(!Buffer.from(body).includes(original));
  assert.ok(restore(result.text, map).includes(roster[0].name));
});

test('extension requests contain no roster name, hash, or salt', () => {
  const files = ['service-worker.js', 'command-runner-worker.js', 'offscreen.js', 'content/private-files.js'];
  const transport = files.map(source).join('\n');
  assert.doesNotMatch(transport, /swap-hash|swap_hash|hashSalt|swapHashes|\.hashes\b/u);
  assert.doesNotMatch(source('service-worker.js').match(/async function swapStatus\(\) \{[\s\S]*?\n\}/u)?.[0] || '', /rosterCount|hashes|salt/u);
  for (const client of roster) assert.ok(!transport.includes(client.name));
  assert.match(transport, /new File\(\[result\.text\]/u);
  assert.match(transport, /Images stay on this computer in private mode/u);
  assert.match(transport, /navigator\.clipboard\.writeText\(restored\?\.text \|\| raw\)/u);
  assert.match(transport, /anchor\.download = name/u);
});

test('private image selection is refused before any upload request', async () => {
  const listeners = new Map();
  const notices = [];
  const requests = [];
  const context = {
    chrome: { runtime: { sendMessage: async (payload) => { requests.push(payload); return { private: true, swap: { active: true } }; } } },
    document: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      createElement: () => ({ setAttribute() {}, addEventListener() {}, set className(value) {}, set textContent(value) { notices.push(value); } }),
      querySelector: () => null, body: { append() {} },
    },
    File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } },
    window: { confirm: () => true },
    console, setTimeout, URL, Blob, TextEncoder,
  };
  vm.runInNewContext(source('content/private-files.js') + '\nglobalThis.prepareForTest = prepare;', context);
  const result = await context.prepareForTest([{ name: 'scan.png', type: 'image/png' }]);
  assert.equal(result.files.length, 0);
  assert.match(notices.join(' '), /Images stay on this computer in private mode/u);
  assert.ok(!requests.some((item) => item.type === 'swap-scrub-document'));
});
