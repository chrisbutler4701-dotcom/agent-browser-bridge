// This page intentionally has no page access. It only relays a bounded command
// transport worker to the service worker, which remains the executor.
let runner = null;
let runnerSettings = null;

// Silent oscillator keeps the offscreen document eligible for audio playback
// while its command worker holds the browser connection.
try {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.value = 0.0001;
  const oscillator = context.createOscillator();
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
} catch { /* The worker still runs when audio is unavailable. */ }

function relayTransportState(state) {
  chrome.runtime.sendMessage({ type: 'durable-runner-transport-state', state }).catch(() => {});
}

function startRunner(settings) {
  runnerSettings = settings;
  if (!runner) {
    runner = new Worker('command-runner-worker.js', { type: 'module' });
    const activeRunner = runner;
    runner.onmessage = async (event) => {
      const message = event.data || {};
      if (message.type === 'transport-state') return relayTransportState(message.state);
      if (message.type === 'browser-identity') {
        chrome.runtime.sendMessage({ type: 'durable-runner-browser-identity', browser: message.browser }).catch(() => {});
        return;
      }

      if (message.type !== 'execute-command') return;
      let outcome = { ok: false, error: 'Command executor did not respond.' };
      try { outcome = await chrome.runtime.sendMessage({ type: 'durable-runner-execute-command', command: message.command }); } catch { /* Do not expose transport details. */ }
      activeRunner.postMessage({ type: 'command-result', deliveryId: message.deliveryId, outcome });
    };
    runner.onerror = () => {
      if (runner !== activeRunner) return;
      activeRunner.terminate();
      runner = null;
      relayTransportState('failed');
      if (runnerSettings?.controlEnabled === true) startRunner(runnerSettings);
    };
  }
  runner.postMessage({ type: 'configure', settings });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'durable-runner-configure') return false;
  if (message.controlEnabled === true && typeof message.brokerUrl === 'string' && typeof message.brokerToken === 'string') {
    startRunner(message);
    sendResponse({ ok: true, ready: true });
  } else {
    runnerSettings = null;
    runner?.postMessage({ type: 'stop' });
    sendResponse({ ok: true, ready: false });
  }
  return false;
});
