import assert from 'node:assert/strict';
import test from 'node:test';
import { captureTabForDelivery } from '../extension/service-worker.js';
import { saveSwap } from '../extension/swap-store.js';

function fakeIndexedDb() {
  const values = new Map();
  const db = { createObjectStore() {}, close() {}, transaction() { return { objectStore() { return {
    get(key) { const request = {}; queueMicrotask(() => { request.result = values.get(key); request.onsuccess?.(); }); return request; },
    put(value, key) { const request = {}; queueMicrotask(() => { values.set(key, value); request.onsuccess?.(); }); return request; },
  }; } }; } };
  return { open() { const request = { result: db }; queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } };
}

test('private capture sent to broker has no roster value or screenshot', async () => {
  const original = { chrome: globalThis.chrome, indexedDB: globalThis.indexedDB, fetch: globalThis.fetch };
  const local = { brokerUrl: 'https://broker.example/work-edge/ingest', brokerToken: 'paired' };
  let delivered = null;
  const tab = { id: 1, url: 'https://example.test/case', title: 'Maya Ellison', windowId: 1 };
  globalThis.indexedDB = fakeIndexedDb();
  globalThis.chrome = {
    storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); }, async set(value) { Object.assign(local, value); } },
      session: { async get() { return { browserIdentity: { private: true } }; }, async set() {} } },
    permissions: { async contains() { return true; } },
    scripting: { async executeScript() { return [{ frameId: 0, result: { url: tab.url, title: tab.title, text: 'Maya Ellison DOB 04/12/1988 called 212-555-0101', elementSummary: [{ tag: 'input', text: 'Maya Ellison' }], rows: [] } }]; } },
    tabs: { async query() { return [tab]; } },
  };
  globalThis.fetch = async (_url, options) => { delivered = options.body; return { ok: true }; };
  try {
    await saveSwap({ roster: [{ name: 'Maya Ellison', aliases: [], dob: '04/12/1988' }], map: {} });
    const result = await captureTabForDelivery(tab, true, true, false);
    assert.equal(result.ok, true);
    for (const real of ['Maya Ellison', '04/12/1988', '212-555-0101']) assert.equal(delivered.includes(real), false);
    assert.equal(delivered.includes('data:image'), false);
    assert.match(delivered, /\[CLIENT-1\]/u);
  } finally { Object.assign(globalThis, original); }
});
