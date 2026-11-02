import assert from 'node:assert/strict';
import test from 'node:test';

test('changing server origin requires permission before clearing pairing and control', async () => {
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const local = {
    brokerUrl: 'https://old.example/work-edge/ingest',
    brokerToken: 'paired-token',
    hermesControlEnabled: true,
    commandResume: { lastReceivedSeq: 3 }
  };
  const requested = [];
  globalThis.chrome = {
    permissions: { async request(value) { requested.push(value); return false; } },
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])); },
        async set(values) { Object.assign(local, values); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]; }
      },
      session: { async get() { return {}; }, async set() {}, async remove() {} }
    }
  };
  globalThis.WebSocket = undefined;
  try {
    const worker = await import(`../extension/service-worker.js?broker-settings=${Date.now()}`);
    assert.deepEqual(await worker.saveBrokerUrl('http://remote.example/work-edge/ingest'), { ok: false, error: 'Enter an HTTPS server address, or HTTP on localhost.' });
    assert.deepEqual(requested, []);
    assert.equal(local.brokerUrl, 'https://old.example/work-edge/ingest');

    assert.deepEqual(await worker.saveBrokerUrl('https://new.example/work-edge/ingest'), { ok: false, error: 'Permission to reach that server was not granted.' });
    assert.deepEqual(requested, [{ origins: ['https://new.example/*'] }]);
    assert.equal(local.brokerUrl, 'https://old.example/work-edge/ingest');
    assert.equal(local.brokerToken, 'paired-token');
    assert.equal(local.hermesControlEnabled, true);

    globalThis.chrome.permissions.request = async () => true;
    assert.deepEqual(await worker.saveBrokerUrl('https://new.example/work-edge/ingest'), { ok: true, brokerUrl: 'https://new.example/work-edge/ingest', pairingReset: true });
    assert.equal(local.brokerUrl, 'https://new.example/work-edge/ingest');
    assert.equal(local.brokerToken, undefined);
    assert.equal(local.hermesControlEnabled, false);
    assert.equal(local.commandResume, undefined);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalWebSocket;
  }
});
