import assert from 'node:assert/strict';
import test from 'node:test';

const settings = {
  brokerUrl: 'http://127.0.0.1:8765/ingest',
  brokerToken: 'paired-token',
  controlEnabled: true,
  extensionVersion: '1.0.3'
};

test('repeat offscreen configuration reaches the existing runner', async () => {
  const originalChrome = globalThis.chrome;
  const originalWorker = globalThis.Worker;
  const workers = [];
  let listener;
  class FakeWorker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(value) { listener = value; } },
      async sendMessage() { return { ok: true }; }
    }
  };
  try {
    await import(`../extension/offscreen.js?repeat-configure=${Date.now()}`);
    const message = { type: 'durable-runner-configure', ...settings };
    listener(message, {}, () => {});
    listener(message, {}, () => {});

    assert.equal(workers.length, 1, 'repeat supervision must reuse the dedicated worker');
    assert.deepEqual(workers[0].messages, [
      { type: 'configure', settings: message },
      { type: 'configure', settings: message }
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.Worker = originalWorker;
  }
});

test('offscreen configuration recreates a failed runner', async () => {
  const originalChrome = globalThis.chrome;
  const originalWorker = globalThis.Worker;
  const workers = [];
  let listener;
  class FakeWorker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(value) { listener = value; } },
      async sendMessage() { return { ok: true }; }
    }
  };
  try {
    await import(`../extension/offscreen.js?failed-runner=${Date.now()}`);
    const message = { type: 'durable-runner-configure', ...settings };
    listener(message, {}, () => {});
    workers[0].onerror();

    assert.equal(workers[0].terminated, true);
    assert.equal(workers.length, 2, 'the failed dedicated worker is replaced without another supervisor wake');
    assert.deepEqual(workers[1].messages, [{ type: 'configure', settings: message }]);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.Worker = originalWorker;
  }
});

test('repeat runner configuration re-reports an open transport without replacing it', async () => {
  const originalSelf = globalThis.self;
  const originalPostMessage = globalThis.postMessage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const sockets = [];
  const published = [];
  let runner;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; sockets.push(this); }
    send() {}
    close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  }
  globalThis.self = {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.postMessage = (message) => published.push(message);
  globalThis.fetch = async () => new Promise(() => {});
  try {
    await import(`../extension/command-runner-worker.js?repeat-configure=${Date.now()}`);
    runner = globalThis.self;
    runner.onmessage({ data: { type: 'configure', settings } });
    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ type: 'hello', ok: true }) });
    runner.onmessage({ data: { type: 'configure', settings } });

    assert.equal(sockets.length, 1, 'an OPEN socket must not be replaced by supervision');
    assert.equal(
      published.filter((message) => message.type === 'transport-state' && message.state === 'websocket').length,
      2,
      'repeat configuration must re-report the acknowledged transport state'
    );
  } finally {
    runner?.onmessage({ data: { type: 'stop' } });
    globalThis.self = originalSelf;
    globalThis.postMessage = originalPostMessage;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test('runner schedules a WebSocket retry when construction throws', async () => {
  const originalSelf = globalThis.self;
  const originalPostMessage = globalThis.postMessage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.self = {};
  globalThis.postMessage = () => {};
  globalThis.WebSocket = class ThrowingWebSocket {
    static OPEN = 1;
    constructor() { throw new Error('connection setup failed'); }
  };
  globalThis.fetch = async () => { throw new Error('polling unavailable'); };
  globalThis.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  try {
    await import(`../extension/command-runner-worker.js?constructor-retry=${Date.now()}`);
    globalThis.self.onmessage({ data: { type: 'configure', settings } });
    await Promise.resolve();

    assert.equal(scheduled.length, 1, 'socket construction failure must leave a pending reconnect');
    assert.equal(scheduled[0].delay, 1_000);
  } finally {
    globalThis.self = originalSelf;
    globalThis.postMessage = originalPostMessage;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('durable runner reconnects after unanswered hello and after 25 seconds without broker replies', async () => {
  const previous = { self: globalThis.self, postMessage: globalThis.postMessage, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const timers = new Map();
  const sockets = [];
  let nextTimer = 0;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.self = {};
  globalThis.postMessage = () => {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => new Promise(() => {});
  globalThis.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.setInterval = () => ++nextTimer;
  globalThis.clearInterval = () => {};
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected a ${delay} ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  try {
    await import(`../extension/command-runner-worker.js?watchdog=${Date.now()}`);
    const runner = globalThis.self;
    runner.onmessage({ data: { type: 'configure', settings } });
    sockets[0].readyState = 1;
    sockets[0].onopen();
    fire(10_000);
    assert.equal(sockets[0].readyState, 3, 'unanswered hello closes the socket');
    fire(1_000);
    sockets[1].readyState = 1;
    sockets[1].onopen();
    sockets[1].onmessage({ data: JSON.stringify({ type: 'hello', ok: true }) });
    assert.equal([...timers.values()].some((timer) => timer.delay === 10_000), false, 'hello clears handshake timeout');
    const firstReplyTimer = [...timers].find(([, timer]) => timer.delay === 25_000)[0];
    sockets[1].onmessage({ data: JSON.stringify({ type: 'keepalive', ok: true }) });
    assert.equal(timers.has(firstReplyTimer), false, 'every broker reply resets watchdog');
    fire(25_000);
    assert.equal(sockets[1].readyState, 3, 'watchdog closes an unresponsive socket');
    runner.onmessage({ data: { type: 'stop' } });
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('supervising an existing offscreen runner preserves its last heartbeat until it re-reports', async () => {
  const originalChrome = globalThis.chrome;
  const heartbeat = { state: 'websocket', diagnostic: 'websocket_active', at: Date.now() };
  const session = { commandPollHeartbeat: heartbeat };
  globalThis.chrome = {
    runtime: {
      id: 'heartbeat-supervision-test',
      getURL(path) { return `chrome-extension://heartbeat-supervision-test/${path}`; },
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
      async sendMessage() { return { ok: true, ready: true }; },
      onMessage: { addListener() {} },
      onConnect: { addListener() {} },
      getManifest() { return { version: '1.0.3' }; }
    },
    offscreen: {},
    storage: {
      local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, settings[key] ?? (key === 'hermesControlEnabled' ? true : undefined)])); } },
      session: { async get() { return session; }, async set(values) { Object.assign(session, values); } }
    },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 }
  };
  try {
    await import(`../extension/service-worker.js?preserve-heartbeat=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(session.commandPollHeartbeat, heartbeat);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
