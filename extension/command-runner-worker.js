import { websocketEndpointUrl } from './broker-url.js';

// A look-first refusal carries a fresh snapshot the agent needs to decide again.
function lookFirstPayload(outcome) { return outcome?.code === 'look_first' ? { page: outcome.page, capture: outcome.capture } : undefined; }

let socket = null;
let generation = 0;
let settings = null;
let nextDeliveryId = 0;
let keepaliveTimer = null;
let helloTimer = null;
let replyTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let transportState = 'starting';
const pending = new Map();
const SOCKET_KEEPALIVE_MS = 10_000;
const SOCKET_HELLO_TIMEOUT_MS = 10_000;
const SOCKET_REPLY_TIMEOUT_MS = 25_000;
const state = (value, current = generation) => {
  if (current !== generation) return;
  transportState = value;
  postMessage({ type: 'transport-state', state: value });
};
const endpoint = (path) => new URL(`/work-edge/commands/${path}`, settings.brokerUrl).toString();

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  clearTimeout(helloTimer);
  clearTimeout(replyTimer);
  helloTimer = null;
  replyTimer = null;
}

function stopReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(current) {
  if (current !== generation || settings?.controlEnabled !== true) return;
  stopReconnect();
  const delay = Math.min(30_000, 1_000 * Math.pow(1.5, reconnectAttempts++));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (current === generation) startTransport();
  }, delay);
}

function reconnect(current, connectedSocket = socket) {
  if (current !== generation || socket !== connectedSocket || settings?.controlEnabled !== true) return;
  stopKeepalive();
  socket = null;
  try { connectedSocket?.close(); } catch { /* Retry is scheduled below. */ }
  state('starting', current);
  startPolling(current);
  scheduleReconnect(current);
}

function resetReplyTimer(current, connectedSocket) {
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => reconnect(current, connectedSocket), SOCKET_REPLY_TIMEOUT_MS);
}

function renewLease(current, connectedSocket = socket) {
  if (current !== generation || socket !== connectedSocket || connectedSocket?.readyState !== WebSocket.OPEN || settings?.controlEnabled !== true) return;
  connectedSocket.send(JSON.stringify({ type: 'keepalive', controlEnabled: true, runnerDiagnostic: 'websocket_active', swap: settings.swap }));
}

function deliver(current, command, sendResult) {
  if (current !== generation || settings?.controlEnabled !== true) return;
  const deliveryId = ++nextDeliveryId;
  pending.set(deliveryId, { current, sendResult });
  postMessage({ type: 'execute-command', deliveryId, command });
}

function startPolling(current) {
  (async () => {
    while (current === generation && settings?.controlEnabled === true && socket?.readyState !== WebSocket.OPEN) {
      let response;
      try {
        response = await fetch(endpoint('poll'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
          body: JSON.stringify({ waitMs: 25_000, controlEnabled: true, extensionVersion: settings.extensionVersion, runnerDiagnostic: 'polling_recovery_active', swap: settings.swap }),
          cache: 'no-store'
        });
      } catch {
        state('failed', current);
        return;
      }
      if (current !== generation || settings?.controlEnabled !== true) return;
      const payload = await response.json().catch(() => ({}));
      if (current !== generation || settings?.controlEnabled !== true) return;
      if (!response.ok) { state('failed', current); return; }
      state('active', current);
      if (!payload.command) continue;
      await new Promise((resolve) => deliver(current, payload.command, async (outcome) => {
        if (current !== generation || settings?.controlEnabled !== true) return resolve();
        try {
          await fetch(endpoint('result'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
            body: JSON.stringify({ id: payload.command.id, ok: outcome?.ok === true, result: outcome?.result ?? lookFirstPayload(outcome), error: outcome?.error, code: outcome?.code }),
            cache: 'no-store'
          });
        } catch {
          state('failed', current);
        }
        resolve();
      }));
    }
  })();
}

function startTransport() {
  const current = ++generation;
  stopKeepalive();
  stopReconnect();
  state('starting', current);
  if (!settings?.brokerToken) {
    return;
  }
  try {
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
    const wsUrl = websocketEndpointUrl(settings.brokerUrl);
    if (!wsUrl) {
      state('failed', current);
      startPolling(current);
      scheduleReconnect(current);
      return;
    }
    const connectedSocket = new WebSocket(wsUrl);
    socket = connectedSocket;
    connectedSocket.onopen = () => {
      if (current !== generation || socket !== connectedSocket) return;
      state('starting', current);
      connectedSocket.send(JSON.stringify({
        type: 'hello',
        token: settings.brokerToken,
        controlEnabled: true,
        extensionVersion: settings.extensionVersion,
        swap: settings.swap,
        runnerDiagnostic: 'runner_configured_unacknowledged'
      }));
      helloTimer = setTimeout(() => reconnect(current, connectedSocket), SOCKET_HELLO_TIMEOUT_MS);
      // The broker's eligibility lease is intentionally shorter than the MV3
      // lifetime. Keep it renewed even when no commands arrive after a result.
      keepaliveTimer = setInterval(() => renewLease(current, connectedSocket), SOCKET_KEEPALIVE_MS);
    };
    connectedSocket.onmessage = (event) => {
      if (current !== generation || socket !== connectedSocket || settings?.controlEnabled !== true) return;
      resetReplyTimer(current, connectedSocket);
      if (transportState === 'websocket') state('websocket', current);
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'hello' && message.ok === true) {
        clearTimeout(helloTimer);
        helloTimer = null;
        if (message.browser) postMessage({ type: 'browser-identity', browser: message.browser });
        reconnectAttempts = 0;
        state('websocket', current);
        return renewLease(current, connectedSocket);
      }
      if (message.type === 'keepalive' && message.ok === true && message.browser) {
        postMessage({ type: 'browser-identity', browser: message.browser });
        return;
      }

      if (message.type !== 'command' || !message.command) return;
      if (connectedSocket.readyState === WebSocket.OPEN) {
        connectedSocket.send(JSON.stringify({ type: 'command-received', id: message.command.id, seq: message.seq }));
      }
      deliver(current, message.command, (outcome) => {
        if (current === generation && socket === connectedSocket && settings?.controlEnabled === true && connectedSocket.readyState === WebSocket.OPEN) {
          connectedSocket.send(JSON.stringify({
            type: 'result',
            id: message.command.id,
            ok: outcome?.ok === true,
            result: outcome?.result ?? lookFirstPayload(outcome),
            error: outcome?.error,
            code: outcome?.code
          }));
          // A capture delivery may be unavailable or rejected independently of
          // this safe command result. Renewing here keeps that condition from
          // being misdiagnosed as a lost command channel.
          renewLease(current, connectedSocket);
        }
      });
    };
    connectedSocket.onerror = () => {
      reconnect(current, connectedSocket);
    };
    connectedSocket.onclose = () => {
      if (current === generation && socket === connectedSocket) {
        reconnect(current, connectedSocket);
      }
    };
  } catch {
    state('starting', current);
    startPolling(current);
    scheduleReconnect(current);
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'configure') {
    const unchanged = JSON.stringify(settings) === JSON.stringify(message.settings);
    settings = message.settings;
    if (unchanged && socket?.readyState === WebSocket.OPEN) {
      state(transportState === 'websocket' ? 'websocket' : 'starting');
      return;
    }
    if (unchanged && socket?.readyState === WebSocket.CONNECTING) {
      state('starting');
      return;
    }
    startTransport();
  }
  if (message.type === 'stop') {
    generation += 1;
    stopKeepalive();
    stopReconnect();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
      socket = null;
    }
    pending.clear();
    state('failed');
  }
  if (message.type === 'command-result') {
    const pendingDelivery = pending.get(message.deliveryId);
    pending.delete(message.deliveryId);
    if (pendingDelivery?.current === generation) pendingDelivery.sendResult(message.outcome);
  }

};
