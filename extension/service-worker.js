import { brokerOrigin, normalizeBrokerUrl, pairExchangeUrl, validateBrokerUrl, verifiedActionEndpointUrl, websocketEndpointUrl } from './broker-url.js';
import { HOSTED_INGEST_URL, HOSTED_COCKPIT_URL } from './hosted-default.js';
import { executeBrowserCommand, executeVerifiedActionCommand } from './command-executor.js';
import { parseFrameTarget, scopeFrameRef } from './frame-scope.js';
import { capturePage } from './content/capture.js';
import { registerInstallSetup } from './install-setup.js';
import { scrub, restore } from './swap.js';
import { loadSwap, saveSwap, normalizeRoster } from './swap-store.js';

const CAPTURE_KEY = 'latestExplicitCapture';
export const READ_MONITORING_ENABLED_KEY = 'readMonitoringEnabled';
export const READ_EDITABLE_TEXT_KEY = 'readEditableText';
export const SENSITIVE_READ_RESTRICTED_KEY = 'sensitiveReadRestricted';
// Sensitive origins need their own durable, exact-origin consent. This does
// not grant browser control or trust arbitrary new origins.
export const APPROVED_SENSITIVE_READ_ORIGINS_KEY = 'approvedSensitiveReadOrigins';
// Keep the pre-rebuild storage key so installed browsers retain their explicit
// control setting across the product rename.
export const CONTROL_ENABLED_KEY = 'hermesControlEnabled';
export const COMMAND_POLL_HEARTBEAT_KEY = 'commandPollHeartbeat';
export const COMMAND_RESUME_KEY = 'commandResume';
const COMMAND_TRANSPORT_ALARM = 'work-edge-command-transport';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const RUNNER_HEARTBEAT_MAX_AGE_MS = 30_000;
let contextUiOpen = false;
let commandPolling = false;
let controlPortCount = 0;
let brokerSocket = null;
let socketConnecting = false;
let socketRetry = 0;
let socketRetryTimer = null;
let socketKeepaliveTimer = null;
let offscreenCreation = null;
let durableRunnerEnsure = null;
const NAVIGATION_COMPLETE_TIMEOUT_MS = 10_000;
// Gmail and Outlook update their reading panes asynchronously after an in-page
// row click. Keep this bounded so ordinary commands do not wait on SPA work
// indefinitely.
const PAGE_STATE_CAPTURE_SETTLE_MS = 750;
const MAX_SCREENSHOT_DATA_URL_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_TEXT_CHARS = 200_000;
// The broker treats a browser as stale after 15 seconds, so renew the WSS
// lease inside that window.
const SOCKET_KEEPALIVE_MS = 10_000;
// Outlook can move between these two application origins after sign-in or
// navigation. Keep this deliberately enumerated: it is not a Microsoft or
// Office domain wildcard and does not include account or login origins.
const OUTLOOK_APP_ORIGINS = new Set([
  'https://outlook.office.com',
  'https://outlook.cloud.microsoft'
]);

async function privateBrowser() {
  if (!chrome.storage?.session?.get) return false;
  const identity = (await chrome.storage.session.get('browserIdentity')).browserIdentity;
  // Unknown identity is treated as private until the broker confirms otherwise.
  return identity?.private !== false;
}

const SWAP_DISPLAY_SCRIPTS = ['vendor/mammoth.browser.min.js', 'content/restore-display.js', 'content/private-files.js'];

// Chrome drops registered content scripts when the extension updates or reloads.
// Re-register the local display once the user has allowed it, so swapping stays on.
async function ensureSwapDisplay() {
  if (typeof chrome === 'undefined' || !chrome.scripting?.registerContentScripts || !chrome.storage?.local) return false;
  const { swapDisplayOrigin } = await chrome.storage.local.get('swapDisplayOrigin');
  if (!swapDisplayOrigin) return false;
  const pattern = `${swapDisplayOrigin}/*`;
  if (chrome.permissions?.contains && !(await chrome.permissions.contains({ origins: [pattern] }))) return false;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['swap-display'] });
  if (existing.some((script) => script.matches?.includes(pattern))) return true;
  await chrome.scripting.unregisterContentScripts({ ids: ['swap-display'] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{ id: 'swap-display', matches: [pattern], js: SWAP_DISPLAY_SCRIPTS, runAt: 'document_idle', allFrames: true }]);
  return true;
}
void ensureSwapDisplay().catch(() => {});

async function swapStatus() {
  try {
    if (!chrome.storage?.session?.get) return { active: false, rules: false };
    const identity = (await chrome.storage.session.get('browserIdentity')).browserIdentity;
    if (identity?.private !== true) return { active: false, rules: false };
    const state = await loadSwap();
    const local = await chrome.storage.local.get(['cockpitUrl', 'swapDisplayOrigin']);
    const origin = new URL(local.cockpitUrl || HOSTED_COCKPIT_URL).origin;
    await ensureSwapDisplay().catch(() => {});
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['swap-display'] });
    const displayReady = local.swapDisplayOrigin === origin && scripts.some((script) => script.matches?.includes(`${origin}/*`));
    return { active: state.roster.length > 0 && displayReady, rules: true };
  } catch { return { active: false, rules: false }; }
}

async function scrubPayload(payload, { keepUrls = false } = {}) {
  if (typeof indexedDB === 'undefined' && typeof process !== 'undefined' && process.versions?.node) return { clean: payload, replaced: [] };
  const state = await loadSwap();
  const replaced = [];
  const pageUrl = (value) => {
    try {
      const parsed = new URL(value);
      if (!/^https?:$/u.test(parsed.protocol)) return '';
      state.map.pages ||= {};
      const address = `${parsed.origin}${parsed.pathname}`;
      state.map.pages[address] ||= `${parsed.origin}/.swap/${crypto.randomUUID()}`;
      return state.map.pages[address];
    } catch { return ''; }
  };
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key === 'origin') { try { return new URL(value).origin; } catch { return ''; } }
      if (['url', 'address', 'href', 'requestedUrl'].includes(key)) return pageUrl(value);
      if (!keepUrls) value = value.replace(/https?:\/\/[^\s<>"']+/gu, (url) => pageUrl(url));
      const result = scrub(value, state.roster, state.map);
      replaced.push(...result.replaced);
      return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    return value;
  };
  const clean = walk(payload);
  await saveSwap(state);
  return { clean, replaced };
}

// The action has no popup, so the toolbar icon must open the side panel.
if (typeof chrome !== 'undefined' && chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled && chrome.tabs?.create) {
  registerInstallSetup(chrome);
}

// Registered only inside the extension so this module stays importable in Node.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'capture-active-tab') {
      captureActiveTab().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'capture-active-tab-session') {
      captureActiveTabSession().then(sendResponse).catch(async (error) => sendResponse(await unavailablePage(error)));
      return true;
    }
    if (message.type === 'context-ui-open') {
      contextUiOpen = true;
      captureActiveTab().then(sendResponse).catch(async (error) => sendResponse(await unavailablePage(error)));
      return true;
    }
    if (message.type === 'context-ui-closed') {
      contextUiOpen = false;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'capture-status') {
      captureStatus().then(sendResponse).catch((error) => sendResponse({ capture: null, stale: true, activeTab: null, error: error.message }));
      return true;
    }
    if (message.type === 'approve-sensitive-read-origin') {
      approveSensitiveReadOrigin().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'forget-sensitive-read-origin') {
      forgetSensitiveReadOrigin().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'set-sensitive-read-restricted') {
      setSensitiveReadRestricted(message.restricted).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'set-read-editable-text') {
      setReadEditableText(message.enabled).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'pair-browser') {
      pairBrowser(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'save-broker') {
      saveBrokerUrl(message.brokerUrl).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'reset-pairing') {
      reportControlState(false);
      chrome.storage.local.remove(['brokerToken', CONTROL_ENABLED_KEY, COMMAND_RESUME_KEY])
        .then(async () => {
          await chrome.storage.session.remove(['browserIdentity', 'lastActingAgent']);
          await ensureDurableCommandRunner();
          brokerSocket?.close();
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'broker-status') {
      Promise.all([
        chrome.storage.local.get(['brokerUrl', 'brokerToken', CONTROL_ENABLED_KEY, READ_MONITORING_ENABLED_KEY, READ_EDITABLE_TEXT_KEY, SENSITIVE_READ_RESTRICTED_KEY, APPROVED_SENSITIVE_READ_ORIGINS_KEY]),
        chrome.storage.session.get([COMMAND_POLL_HEARTBEAT_KEY, 'lastActingAgent', 'browserIdentity'])
      ]).then(([value, session]) => sendResponse({
        configured: Boolean(value.brokerUrl),
        paired: Boolean(value.brokerToken),
        controlEnabled: value[CONTROL_ENABLED_KEY] === true,
        readMonitoringEnabled: value[READ_MONITORING_ENABLED_KEY] !== false,
        readEditableText: value[READ_EDITABLE_TEXT_KEY] === true,
        sensitiveReadRestricted: value[SENSITIVE_READ_RESTRICTED_KEY] === true,
        approvedSensitiveOriginCount: normalizeApprovedOrigins(value[APPROVED_SENSITIVE_READ_ORIGINS_KEY]).length,
        pollHeartbeat: session[COMMAND_POLL_HEARTBEAT_KEY] || null,
        lastActingAgent: session.lastActingAgent || null,
        browserIdentity: session.browserIdentity || null
      })).catch((error) => sendResponse({
        configured: false,
        paired: false,
        controlEnabled: false,
        readMonitoringEnabled: false,
        readEditableText: false,
        sensitiveReadRestricted: false,
        approvedSensitiveOriginCount: 0,
        pollHeartbeat: null,
        lastActingAgent: null,
        browserIdentity: null,
        error: error.message
      }));
      return true;
    }
    if (message.type === 'swap-state') {
      Promise.all([chrome.storage.session.get('browserIdentity'), loadSwap(), swapStatus()]).then(([session, state, swap]) => {
        const privateMode = session.browserIdentity?.private === true;
        sendResponse({ private: privateMode, roster: privateMode ? state.roster : [], swap: { ...swap, rosterCount: state.roster.length } });
      })
        .catch((error) => sendResponse({ private: true, swap: { active: false, rosterCount: 0, rules: false }, error: error.message }));
      return true;
    }
    if (message.type === 'swap-save') {
      chrome.storage.session.get('browserIdentity').then(async (session) => {
        if (session.browserIdentity?.private !== true) throw new Error('Privacy roster is available only for a private browser.');
        const state = await loadSwap();
        state.roster = normalizeRoster(message.roster);
        await saveSwap(state);
        void ensureDurableCommandRunner().catch(() => {});
        return { ok: true, rosterCount: state.roster.length };
      }).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'swap-restore') {
      loadSwap().then((state) => state.roster.length ? restore(message.text, state.map) : String(message.text || ''))
        .then((text) => sendResponse({ text })).catch(() => sendResponse({ text: String(message.text || '') }));
      return true;
    }
    if (message.type === 'swap-scrub') {
      loadSwap().then(async (state) => state.roster.length ? (await scrubPayload(String(message.text || ''), { keepUrls: true })).clean : String(message.text || ''))
        .then((text) => sendResponse({ text })).catch(() => sendResponse({ error: 'Privacy scrubbing is unavailable.' }));
      return true;
    }
    if (message.type === 'swap-context') {
      Promise.all([privateBrowser(), swapStatus(), loadSwap()]).then(([privateMode, swap, state]) => sendResponse({ private: privateMode, swap, localRosterReady: state.roster.length > 0 }))
        .catch(() => sendResponse({ private: true, swap: { active: false } }));
      return true;
    }
    if (message.type === 'swap-scrub-document') {
      (async () => {
        const state = await loadSwap();
        if (!state.roster.length) throw new Error('Private swapping is unavailable on this computer.');
        const result = scrub(String(message.text || ''), state.roster, state.map);
        await saveSwap(state);
        const counts = {};
        for (const item of result.replaced) counts[item.standIn] = (counts[item.standIn] || 0) + 1;
        return { text: result.text, replaced: result.replaced.length, counts };
      })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message.type === 'swap-local-vision') {
      (async () => {
        const dataUrl = String(message.dataUrl || '');
        if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(dataUrl) || dataUrl.length > 12_000_000) throw new Error('The image is too large or unsupported.');
        const base = 'http://127.0.0.1:1234/v1';
        const modelsResponse = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
        if (!modelsResponse.ok) throw new Error('No local vision model is available on this machine.');
        const models = await modelsResponse.json();
        const model = models?.data?.[0]?.id;
        if (typeof model !== 'string') throw new Error('No local vision model is available on this machine.');
        const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image_url', image_url: { url: dataUrl } }] }], max_tokens: 512 }),
          signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('The local model could not read this image.');
        const result = await response.json();
        return { text: String(result?.choices?.[0]?.message?.content || '').slice(0, 6000) };
      })().then(sendResponse).catch(() => sendResponse({ error: 'No local vision model is available on this machine. Nothing was uploaded.' }));
      return true;
    }
    if (message.type === 'swap-register-display') {
      (async () => {
        const origin = new URL(message.origin).origin;
        await chrome.scripting.unregisterContentScripts({ ids: ['swap-display'] }).catch(() => {});
        await chrome.scripting.registerContentScripts([{ id: 'swap-display', matches: [`${origin}/*`], js: SWAP_DISPLAY_SCRIPTS, runAt: 'document_idle', allFrames: true }]);
        await chrome.storage.local.set({ swapDisplayOrigin: origin });
        void ensureDurableCommandRunner().catch(() => {});
        return { ok: true };
      })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'verified-actions-pending') {
      pendingVerifiedActions().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message, pending: [] }));
      return true;
    }
    if (message.type === 'verified-action-decision') {
      decideVerifiedAction(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'set-read-monitoring') {
      setReadMonitoringEnabled(message.enabled).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'toggle-browser-control') { toggleBrowserControl().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message })); return true; }
    if (message.type === 'durable-runner-execute-command') {
      executeCommandInActiveTab(message.command).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'durable-runner-transport-state') {
      const state = ['websocket', 'active', 'starting', 'failed'].includes(message.state) ? message.state : 'failed';
      const diagnostic = runnerDiagnostic(true, true, true, state);
      setRunnerHeartbeat(state, diagnostic).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'durable-runner-browser-identity') {
      const browser = message.browser;
      if (browser && typeof browser.id === 'string' && typeof browser.name === 'string') {
        chrome.storage.session.set({ browserIdentity: { id: browser.id.slice(0, 40), name: browser.name.slice(0, 60), isDefault: browser.isDefault === true, private: browser.private === true } })
          .then(() => ensureDurableCommandRunner()).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'browser-control') return;
    controlPortCount += 1;
    // The offscreen document is the durable command owner. Starting another
    // WSS here creates two sockets for one paired browser and lets either close
    // invalidate the other one's broker lease.
    resumeCommandTransport();
    port.onDisconnect.addListener(() => { controlPortCount = Math.max(0, controlPortCount - 1); });
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => autoCaptureCurrentTab());
  chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === 'complete') autoCaptureCurrentTab(); });
  chrome.windows?.onFocusChanged.addListener((windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) autoCaptureCurrentTab(); });
}

function autoCaptureCurrentTab() {
  // Watch mode begins after normal-tab permission and pairing, unless the user
  // explicitly turns it off in the popup. Sensitive-page restriction is an
  // optional per-site approval mode.
  activeTab().then(async (tab) => {
    const settings = await chrome.storage.local.get(['brokerToken', READ_MONITORING_ENABLED_KEY]);
    if (!settings.brokerToken || settings[READ_MONITORING_ENABLED_KEY] === false || !autoCaptureEligibility(tab).allowed) return;
    chrome.storage.session.remove(CAPTURE_KEY).catch(() => {});
    notifyContext({ ok: false, reading: true, capture: null });
    return captureTabForDelivery(tab, true, false, true);
  }).then((response) => { if (response) notifyContext(response); }).catch(async (error) => notifyContext(await unavailablePage(error)));
}

function notifyContext(payload) {
  const sent = chrome.runtime?.sendMessage?.({ type: 'context-capture-updated', ...payload });
  sent?.catch(() => {});
}

async function captureActiveTab() {
  const { rawCapture: _rawCapture, ...response } = await captureActiveTabForDelivery(true);
  return response;
}

async function captureActiveTabSession() {
  const { rawCapture: _rawCapture, ...response } = await captureActiveTabForDelivery(false, false);
  return response;
}

async function captureActiveTabForDelivery(deliver, userInitiated = true) {
  const tab = await activeTab();
  return captureTabForDelivery(tab, deliver, userInitiated, true);
}

export async function captureTabForDelivery(tab, deliver, userInitiated = true, requireForegroundStability = false) {
  // A successful capture proves this MV3 worker is awake, not that its
  // in-memory WSS survived suspension. Re-establish the authenticated command
  // path on every capture wake so read/watch activity cannot mask a dead
  // control channel when the popup is closed.
  void resumeCommandTransport().catch(() => {});
  if (!tab?.id || !isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read. Open a normal webpage.');
  if (requireForegroundStability === 'tab' && await namedTabChanged(tab)) throw new Error(`Tab ${tab.id} closed or moved to another site before the capture ran, so nothing was read.`);
  if (requireForegroundStability === true && await frontTabChanged(tab)) throw new Error('The front tab changed before the capture ran, so nothing was read.');
  const frameResults = await captureFrames({ tabId: tab.id, allFrames: true });
  const result = frameResults.find((frame) => frame.frameId === 0)?.result || frameResults[0]?.result;
  if (!result?.url || !isCapturableUrl(result.url)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(result.url).origin;
  const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
  const sensitive = isSensitivePage(result);
  const sensitiveReadPersistent = !restrict || isApprovedOrigin(origin, approvedSensitiveOrigins);
  if (restrict && sensitive && !sensitiveReadPersistent) {
    const metadataOnly = { title: result.title, url: result.url, text: '', text_total_chars: 0, truncated: false, elementSummary: [], rows: [], sensitiveSignals: result.sensitiveSignals || [], tabId: tab.id, capturedAt: new Date().toISOString(), userInitiated, sensitiveReadRestricted: true };
    await chrome.storage.session.set({ [CAPTURE_KEY]: metadataOnly });
    const clean = await privateBrowser() ? (await scrubPayload(metadataOnly)).clean : metadataOnly;
    return { ok: true, sent: false, capture: publicCapture(clean, { needsApproval: true, sensitive: true, sensitiveReadRestricted: true, sensitiveReadPersistent: false }), rawCapture: clean, needsApproval: true, sensitive: true, sensitiveReadRestricted: true, sensitiveReadPersistent: false };
  }
  const merged = mergeFrameCaptures(frameResults, restrict, approvedSensitiveOrigins);
  const capture = {
    ...result,
    ...merged,
    tabId: tab.id,
    capturedAt: new Date().toISOString(),
    userInitiated,
    // Only background delivery uses this mode. The broker treats it as a
    // sanitized, approved-origin watch capture, never as control authority.
    readOnlyWatch: deliver && !userInitiated,
    approvedSensitiveOriginCount: approvedSensitiveOrigins.length,
    sensitiveReadRestricted: restrict,
    sensitiveReadPersistent
  };
  await chrome.storage.session.set({ [CAPTURE_KEY]: capture });
  const privateMode = await privateBrowser();
  const scrubbed = privateMode ? await scrubPayload(capture) : { clean: capture, replaced: [] };
  const counts = {};
  for (const { standIn } of scrubbed.replaced) counts[standIn] = (counts[standIn] || 0) + 1;
  const outbound = privateMode ? { ...scrubbed.clean, swapReview: { count: scrubbed.replaced.length, textLength: capture.text.length, counts } } : capture;
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  let sent = false;
  if (deliver && settings.brokerUrl) {
    if (!validateBrokerUrl(settings.brokerUrl)) throw new Error('Enter an HTTPS server address, or HTTP on localhost.');
    if (!settings.brokerToken) throw new Error('Pair this browser before broker delivery.');
    const response = await fetch(settings.brokerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify(outbound), cache: 'no-store' });
    if (!response.ok) throw new Error(`Broker rejected capture (${response.status}).`);
    sent = true;
  }
  return { ok: true, sent, capture: publicCapture(outbound, { sensitive, ...(merged.needsApproval ? { needsApproval: true } : {}), sensitiveReadRestricted: restrict, sensitiveReadPersistent }), rawCapture: outbound, sensitive, ...(merged.needsApproval ? { needsApproval: true } : {}), sensitiveReadRestricted: restrict, sensitiveReadPersistent };
}

async function captureFrames(target) {
  const settings = await chrome.storage.local.get(READ_EDITABLE_TEXT_KEY);
  return chrome.scripting.executeScript({ target, func: capturePage, args: [settings[READ_EDITABLE_TEXT_KEY] === true] });
}

export function mergeFrameCaptures(frameResults, restrict, approvedSensitiveOrigins) {
  const top = frameResults.find((frame) => frame.frameId === 0 && isCapturableUrl(frame?.result?.url))
    || (frameResults.length === 1 && isCapturableUrl(frameResults[0]?.result?.url) ? frameResults[0] : null);
  const pending = frameResults.filter((frame) => frame !== top && frame?.result?.url && Array.isArray(frame.result.framePath));
  const sections = [];
  const elementSummary = [];
  const rows = [];
  const frameContexts = [];
  let needsApproval = false;
  let hiddenChars = 0;
  const originOf = (url) => { try { return new URL(url).origin; } catch { return 'unknown origin'; } };
  const isInherited = (url) => url === 'about:srcdoc' || url === 'about:blank';
  const visit = (frame, origin, parentSensitive = false, topFrame = false) => {
    const page = frame.result;
    const sensitive = parentSensitive || isSensitivePage({ ...page, url: isInherited(page.url) ? `${origin}/` : page.url });
    const restricted = restrict && sensitive && !isApprovedOrigin(origin, approvedSensitiveOrigins);
    if (restricted) {
      needsApproval = true;
      sections.push(`[sensitive frame: ${origin} (approval required)]`);
      return;
    }
    frameContexts.push({ frameId: frame.frameId, url: page.url, origin, sensitive });
    for (const item of page.elementSummary || []) {
      if (elementSummary.length >= 250) break;
      elementSummary.push({ ...item, frameId: frame.frameId, ...(item.ref ? { ref: scopeFrameRef(frame.frameId, item.ref) } : {}) });
    }
    for (const row of page.rows || []) {
      if (rows.length >= 40) break;
      rows.push({ ...row, ref: scopeFrameRef(frame.frameId, row.ref) });
    }
    sections.push(topFrame ? String(page.text || '') : `[frame: ${origin}]\n${String(page.text || '')}`);
    hiddenChars += Math.max(0, (page.text_total_chars || page.text?.length || 0) - (page.text?.length || 0));
    for (const child of page.frameElements || []) {
      if (!Number.isInteger(child.index) || child.index < 0) continue;
      const childPath = [...(page.framePath || []), child.index];
      const index = pending.findIndex((candidate) => candidate.result.framePath.length === childPath.length
        && candidate.result.framePath.every((part, offset) => part === childPath[offset]));
      const childFrame = index >= 0 ? pending.splice(index, 1)[0] : null;
      const childUrl = childFrame?.result?.url || child.url;
      const childOrigin = isInherited(childUrl) ? origin : originOf(childUrl);
      if (childFrame && (isCapturableUrl(childUrl) || isInherited(childUrl))) visit(childFrame, childOrigin, sensitive);
      else sections.push(`[unreadable frame: ${childOrigin}]`);
    }
  };
  if (top) visit(top, originOf(top.result.url), false, true);
  const fullText = sections.filter(Boolean).join('\n');
  const totalChars = fullText.length + hiddenChars;
  return { text: fullText.slice(0, MAX_CAPTURE_TEXT_CHARS), text_total_chars: totalChars, truncated: totalChars > MAX_CAPTURE_TEXT_CHARS, elementSummary, rows, frameContexts, sensitiveSignals: top?.result?.sensitiveSignals || [], needsApproval };
}

export function isCapturableUrl(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol);
  } catch { return false; }
}

export function isEmptyTabUrl(url) {
  const value = String(url || '');
  return value === '' || value === 'about:blank' || value.startsWith('chrome://newtab') || value.startsWith('chrome://new-tab-page');
}

export function isCapturableTab(tab) { return Boolean(tab?.url && isCapturableUrl(tab.url)); }

export function autoCaptureEligibility(tab) {
  if (!isCapturableTab(tab)) return { allowed: false, reason: 'not_capturable' };
  return { allowed: true, origin: new URL(tab.url).origin };
}

export function isApprovedOrigin(origin, approvedOrigins) {
  const normalized = normalizeApprovedOrigins(approvedOrigins);
  if (normalized.includes(origin)) return true;
  return OUTLOOK_APP_ORIGINS.has(origin) && normalized.some((approvedOrigin) => OUTLOOK_APP_ORIGINS.has(approvedOrigin));
}

function withoutApprovedOriginGroup(approvedOrigins, origin) {
  if (!OUTLOOK_APP_ORIGINS.has(origin)) return approvedOrigins.filter((item) => item !== origin);
  return approvedOrigins.filter((item) => !OUTLOOK_APP_ORIGINS.has(item));
}

function pageUnavailable(error, tab = null) {
  return { ok: false, unavailable: true, error: error.message, capture: null, activeTab: activeTabMetadata(tab) };
}

async function unavailablePage(error) { return pageUnavailable(error, await activeTab()); }

async function activeTab() {
  // Foreground only (approved 2026-10-14): never substitute a hidden or background tab.
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return front || null;
}

function tabOrigin(tab) {
  try { return new URL(tab?.url).origin; } catch { return null; }
}

async function frontTabChanged(tab, checkOrigin = true) {
  const front = await activeTab();
  return !front?.id || front.id !== tab.id || (checkOrigin && tabOrigin(front) !== tabOrigin(tab));
}

function tabChangedResult() {
  return { ok: false, code: 'tab_changed', error: 'The front tab changed before the action ran, so nothing was done.' };
}

// Explicit tab targeting (approved in 2026-10-22). An agent may name any
// open tab by id and work it in the background without bringing it to the
// front. A named tab is never substituted: if it closed or left its site, the
// command is refused. With no tabId, commands keep using the front tab.
export async function resolveCommandTab(command) {
  if (command?.tabId === undefined || command?.tabId === null) return { tab: await activeTab(), explicit: false };
  if (!Number.isInteger(command.tabId) || command.tabId < 0) return { error: { ok: false, code: 'tab_invalid', error: 'That tab id is not valid. Use an id from edge_list_open_tabs.' } };
  try {
    return { tab: await chrome.tabs.get(command.tabId), explicit: true };
  } catch {
    return { error: { ok: false, code: 'tab_not_found', error: `Tab ${command.tabId} is no longer open, so nothing was done.` } };
  }
}

async function namedTabChanged(tab, checkOrigin = true) {
  let current = null;
  try { current = await chrome.tabs.get(tab.id); } catch { /* The tab closed. */ }
  return !current?.id || (checkOrigin && tabOrigin(current) !== tabOrigin(tab));
}

function namedTabChangedResult(tab) {
  return { ok: false, code: 'tab_changed', error: `Tab ${tab.id} closed or moved to another site before the action ran, so nothing was done.` };
}

function targetChanged(tab, explicit, checkOrigin = true) {
  return explicit ? namedTabChanged(tab, checkOrigin) : frontTabChanged(tab, checkOrigin);
}

function targetChangedResult(tab, explicit) {
  return explicit ? namedTabChangedResult(tab) : tabChangedResult();
}

// Address without query string or fragment, so tokens in URLs are not listed.
function listedAddress(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname}` : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return null; }
}

// Look before acting (approved in 2026-10-22). The broker sends the page
// address each agent last saw per tab. A click, press, type, or select on a page
// the agent has not seen is refused, and the refusal carries a fresh snapshot so
// the agent can decide again from what is actually on screen.
const LOOK_FIRST_TYPES = new Set(['click', 'press', 'inspect_action', 'type', 'select']);
export function pageIdentity(tab) { return { tabId: tab?.id ?? null, address: listedAddress(tab?.url ?? tab?.pendingUrl ?? '') }; }
export function agentHasSeenPage(command, tab) {
  if (!LOOK_FIRST_TYPES.has(command?.type)) return true;
  const seen = command?.seenPages;
  if (!seen || typeof seen !== 'object') return true; // Local or legacy callers without broker tracking.
  const address = listedAddress(tab?.url ?? '');
  return Boolean(address) && seen[String(tab.id)] === address;
}
async function lookFirstResult(tab, explicit) {
  let capture = null;
  try { capture = (await captureTabForDelivery(tab, true, false, explicit ? 'tab' : true)).capture; } catch { /* The refusal still stands without a snapshot. */ }
  return { ok: false, code: 'look_first', error: 'This page changed or has not been read since your last look, so nothing was done. A fresh snapshot is attached; check it and try again.', page: pageIdentity(tab), capture };
}

async function currentTabOrNull(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

export async function listOpenTabs() {
  const [tabs, front] = await Promise.all([chrome.tabs.query({}), activeTab()]);
  return {
    ok: true,
    result: {
      frontTabId: front?.id ?? null,
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: typeof tab.title === 'string' ? tab.title.slice(0, 200) : null,
        address: listedAddress(tab.url ?? tab.pendingUrl ?? ''),
        front: tab.id === front?.id,
        activeInWindow: tab.active === true,
        readable: isCapturableTab(tab),
        pinned: tab.pinned === true,
        audible: tab.audible === true,
        loading: tab.status === 'loading'
      }))
    }
  };
}

// Like waitForTabComplete, but also settles (and removes its listener and
// timer) when the tab had already finished loading before we started watching.
function waitForTabReady(tabId, timeoutMs = NAVIGATION_COMPLETE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ready);
    };
    const listener = (updatedTabId, change) => { if (updatedTabId === tabId && change.status === 'complete') finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((current) => { if (current?.status === 'complete') finish(true); }).catch(() => {});
  });
}

export async function openTab(command) {
  if (command.url !== undefined && !isSafeRemoteNavigation(command.url)) return { ok: false, error: 'Refused: a new tab can only open a normal URL that is not a final action.' };
  let created;
  try {
    created = await chrome.tabs.create({ ...(command.url ? { url: await realUrl(command.url) } : {}), active: command.active === true });
  } catch {
    return { ok: false, error: 'The browser did not open a new tab.' };
  }
  const ready = command.url ? await waitForTabReady(created.id) : true;
  const tab = await chrome.tabs.get(created.id).catch(() => created);
  return { ok: true, result: { tabId: tab.id, windowId: tab.windowId, front: command.active === true, loaded: ready, title: tab.title || null, address: listedAddress(tab.url ?? tab.pendingUrl ?? command.url ?? '') } };
}

export async function activateTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } catch {
    return { ok: false, error: `Tab ${tab.id} could not be brought to the front.` };
  }
  return { ok: true, result: { tabId: tab.id, windowId: tab.windowId, front: true } };
}

export async function closeTab(tab) {
  try { await chrome.tabs.remove(tab.id); } catch { return { ok: false, error: `Tab ${tab.id} could not be closed.` }; }
  return { ok: true, result: { tabId: tab.id, closed: true } };
}

export async function readTab(tab, maxCharacters) {
  if (!isCapturableTab(tab)) return { ok: false, error: `Tab ${tab.id} is a browser-internal page and cannot be read.` };
  try {
    const captured = await captureTabForDelivery(tab, true, false, 'tab');
    const limit = Number.isInteger(maxCharacters) && maxCharacters > 0 ? Math.min(maxCharacters, MAX_CAPTURE_TEXT_CHARS) : MAX_CAPTURE_TEXT_CHARS;
    return { ok: true, result: { tabId: tab.id, page: pageIdentity(tab), captureDelivered: captured.sent, capture: { ...captured.capture, text: captured.capture.text.slice(0, limit), truncated: captured.capture.truncated || captured.capture.text.length > limit } } };
  } catch (error) {
    return { ok: false, error: error.message || `Tab ${tab.id} could not be read.` };
  }
}

export function activeTabMetadata(tab) {
  if (!tab) return null;
  let url = null;
  try { url = tab.url ? new URL(tab.url).origin : null; } catch { /* A malformed URL cannot be displayed. */ }
  return { title: tab.title || 'Current page', url };
}

export function isFreshCaptureForTab(capture, tab) {
  return Boolean(capture && tab?.id && typeof tab.url === 'string'
    && capture.tabId === tab.id && capture.url === tab.url
    && String(capture.title || '') === String(tab.title || ''));
}

export function isSensitivePage(capture) {
  try {
    const url = new URL(capture?.url || '');
    const sensitivePath = /(?:^|\/)(?:login|signin|sign-in|auth|password|mfa|account)(?:[/?#._-]|$)/i.test(url.pathname);
    const sensitiveHost = /(?:^|\.)(?:login|account)\./i.test(url.hostname) || /microsoftonline\.com$/i.test(url.hostname);
    return sensitivePath || sensitiveHost || (Array.isArray(capture?.sensitiveSignals) && capture.sensitiveSignals.length > 0);
  } catch { return false; }
}

export function publicCapture(capture, state = {}) {
  return { title: capture.title, url: new URL(capture.url).origin, text: capture.text, text_total_chars: capture.text_total_chars, truncated: capture.truncated, capturedAt: capture.capturedAt, ...state };
}

async function readApprovedSensitiveOrigins() {
  const settings = await chrome.storage.local.get(APPROVED_SENSITIVE_READ_ORIGINS_KEY);
  return normalizeApprovedOrigins(settings[APPROVED_SENSITIVE_READ_ORIGINS_KEY]);
}

export async function readSensitiveReadRestricted() {
  const settings = await chrome.storage.local.get(SENSITIVE_READ_RESTRICTED_KEY);
  return settings[SENSITIVE_READ_RESTRICTED_KEY] === true;
}

export function normalizeApprovedOrigins(value) {
  return Array.isArray(value) ? [...new Set(value.filter((origin) => {
    try { return new URL(origin).origin === origin && /^https?:/.test(new URL(origin).protocol); } catch { return false; }
  }))] : [];
}

export async function approveSensitiveReadOrigin() {
  const tab = await activeTab();
  if (!isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(tab.url).origin;
  const approvedSensitiveOrigins = await readApprovedSensitiveOrigins();
  await chrome.storage.local.set({ [APPROVED_SENSITIVE_READ_ORIGINS_KEY]: [...new Set([...approvedSensitiveOrigins, origin])] });
  return captureActiveTabSession();
}

async function forgetSensitiveReadOrigin() {
  const tab = await activeTab();
  if (!isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(tab.url).origin;
  const approvedSensitiveOrigins = withoutApprovedOriginGroup(await readApprovedSensitiveOrigins(), origin);
  await chrome.storage.local.set({ [APPROVED_SENSITIVE_READ_ORIGINS_KEY]: approvedSensitiveOrigins });
  return captureActiveTabSession();
}

async function setReadMonitoringEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Read monitoring must be on or off.');
  await chrome.storage.local.set({ [READ_MONITORING_ENABLED_KEY]: enabled });
  if (enabled) autoCaptureCurrentTab();
  return { ok: true, enabled };
}

async function setReadEditableText(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Editable text reading must be on or off.');
  await chrome.storage.local.set({ [READ_EDITABLE_TEXT_KEY]: enabled });
  await chrome.storage.session.remove(CAPTURE_KEY);
  return { ok: true, readEditableText: enabled };
}

async function setSensitiveReadRestricted(restricted) {
  if (typeof restricted !== 'boolean') throw new Error('Sensitive read restriction must be on or off.');
  await chrome.storage.local.set({ [SENSITIVE_READ_RESTRICTED_KEY]: restricted });
  if (restricted) await chrome.storage.session.remove(CAPTURE_KEY);
  return { ok: true, sensitiveReadRestricted: restricted };
}

async function captureStatus() {
  const [tab, stored, settings] = await Promise.all([activeTab(), chrome.storage.session.get(CAPTURE_KEY), chrome.storage.local.get([APPROVED_SENSITIVE_READ_ORIGINS_KEY, SENSITIVE_READ_RESTRICTED_KEY])]);
  const capture = stored[CAPTURE_KEY] || null;
  if (!isFreshCaptureForTab(capture, tab)) {
    if (capture) await chrome.storage.session.remove(CAPTURE_KEY);
    return { capture: null, stale: true, activeTab: activeTabMetadata(tab), unavailable: !isCapturableTab(tab), error: !isCapturableTab(tab) ? 'Browser-internal and file pages cannot be read.' : null };
  }
  const sensitiveReadRestricted = settings[SENSITIVE_READ_RESTRICTED_KEY] === true;
  const sensitiveReadPersistent = !sensitiveReadRestricted || isApprovedOrigin(new URL(capture.url).origin, settings[APPROVED_SENSITIVE_READ_ORIGINS_KEY]);
  const needsApproval = sensitiveReadRestricted && isSensitivePage(capture) && !sensitiveReadPersistent;
  const clean = await privateBrowser() ? (await scrubPayload(capture)).clean : capture;
  return { capture: publicCapture(clean, { sensitive: isSensitivePage(capture), needsApproval, sensitiveReadRestricted, sensitiveReadPersistent }), stale: false, activeTab: activeTabMetadata(tab), sensitiveReadRestricted };
}

async function pairBrowser({ brokerUrl, code }) {
  if (!brokerUrl) {
    const settings = await chrome.storage.local.get(['brokerUrl']);
    brokerUrl = settings.brokerUrl || HOSTED_INGEST_URL;
  }
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) throw new Error('Enter an HTTPS server address, or HTTP on localhost.');
  if (typeof code !== 'string' || !/^[A-Z2-9]{12}$/.test(code)) throw new Error('Enter the 12-character pairing code.');
  const endpoint = pairExchangeUrl(brokerUrl);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.token !== 'string' || !result.token) throw new Error(result.error || `Pairing was rejected (${response.status}).`);
  await chrome.storage.local.set({ brokerUrl, brokerToken: result.token, [CONTROL_ENABLED_KEY]: false });
  ensureBrokerSocket();
  return { ok: true };
}

export async function saveBrokerUrl(value) {
  const brokerUrl = normalizeBrokerUrl(value);
  if (!validateBrokerUrl(brokerUrl)) return { ok: false, error: 'Enter an HTTPS server address, or HTTP on localhost.' };
  const newOrigin = brokerOrigin(brokerUrl);
  const hostedOrigin = brokerOrigin(HOSTED_INGEST_URL);
  const loopback = new URL(brokerUrl).protocol === 'http:';
  if (newOrigin !== hostedOrigin && !loopback) {
    const granted = await chrome.permissions.request({ origins: [`${newOrigin}/*`] });
    if (!granted) return { ok: false, error: 'Permission to reach that server was not granted.' };
  }
  const settings = await chrome.storage.local.get(['brokerUrl']);
  const originChanged = brokerOrigin(settings.brokerUrl) !== newOrigin;
  if (originChanged) {
    reportControlState(false);
    await chrome.storage.local.remove(['brokerToken', COMMAND_RESUME_KEY]);
    await chrome.storage.local.set({ brokerUrl, [CONTROL_ENABLED_KEY]: false });
    brokerSocket?.close();
    await ensureDurableCommandRunner();
  } else {
    await chrome.storage.local.set({ brokerUrl });
  }
  return { ok: true, brokerUrl, pairingReset: originChanged };
}

async function verifiedActionRequest(action, body) {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  const endpoint = verifiedActionEndpointUrl(settings.brokerUrl, action);
  if (!settings.brokerToken || !endpoint) throw new Error('Pair this browser with an approved broker first.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Verified action request was rejected (${response.status}).`);
  return result;
}

export async function pendingVerifiedActions() {
  const result = await verifiedActionRequest('pending', {});
  return { ok: true, pending: Array.isArray(result.pending) ? result.pending : [] };
}

export async function decideVerifiedAction({ decision, transactionId, proposalHash }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');
  if (typeof transactionId !== 'string' || !transactionId) throw new Error('Transaction ID is required.');
  if (typeof proposalHash !== 'string' || !/^[a-f0-9]{64}$/.test(proposalHash)) throw new Error('Proposal hash is invalid.');
  const result = await verifiedActionRequest(decision, { transactionId, proposalHash });
  return { ok: true, transaction: result.transaction };
}

function commandEndpoint(brokerUrl, path) { return new URL(`/work-edge/commands/${path}`, brokerUrl).toString(); }
function extensionVersion() {
  try { return chrome.runtime?.getManifest?.().version || null; } catch { return null; }
}
export function controlHeartbeatState(enabled, socketOpen) {
  if (!enabled) return 'off';
  return socketOpen ? 'websocket' : 'starting';
}
export function runnerDiagnostic(controlEnabled, offscreenPresent, acknowledged, transportState) {
  if (!controlEnabled) return 'control_disabled';
  if (!offscreenPresent) return 'offscreen_absent';
  if (!acknowledged) return 'runner_configured_unacknowledged';
  if (transportState === 'websocket') return 'websocket_active';
  if (transportState === 'active') return 'polling_recovery_active';
  return 'no_viable_command_transport';
}
function setRunnerHeartbeat(state, diagnostic) {
  return chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state, diagnostic, at: Date.now() } });
}
function reportControlState(enabled) {
  if (socketIsOpen()) brokerSocket.send(JSON.stringify({ type: 'control-state', enabled }));
}

async function toggleBrowserControl() {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  if (!settings.brokerToken || !validateBrokerUrl(settings.brokerUrl)) throw new Error('Pair this browser with an approved broker first.');
  const state = await chrome.storage.local.get(CONTROL_ENABLED_KEY);
  const enabled = state[CONTROL_ENABLED_KEY] !== true;
  await chrome.storage.local.set({ [CONTROL_ENABLED_KEY]: enabled });
  await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: controlHeartbeatState(enabled, brokerSocket?.readyState === WebSocket.OPEN), at: Date.now() } });
  await resumeCommandTransport();
  reportControlState(enabled);
  return { ok: true, enabled };
}

async function offscreenDocumentExists() {
  if (!chrome.offscreen || !chrome.runtime?.getContexts) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [documentUrl] });
  return contexts.some((context) => context.contextType === 'OFFSCREEN_DOCUMENT');
}

// The offscreen page has only chrome.runtime. Its dedicated worker owns network
// transport; every command still returns here for the existing active-tab,
// permission, and final-action checks.
async function ensureDurableCommandRunnerOnce() {
  if (typeof chrome === 'undefined' || !chrome.offscreen || !chrome.runtime?.getURL || !chrome.runtime?.getContexts) return false;
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', CONTROL_ENABLED_KEY]);
  if (settings[CONTROL_ENABLED_KEY] !== true || !settings.brokerToken || !validateBrokerUrl(settings.brokerUrl)) {
    if (await offscreenDocumentExists()) await chrome.offscreen.closeDocument();
    return false;
  }
  let exists = await offscreenDocumentExists();
  if (exists) {
    const heartbeat = (await chrome.storage.session.get(COMMAND_POLL_HEARTBEAT_KEY))[COMMAND_POLL_HEARTBEAT_KEY];
    if (!['websocket', 'active'].includes(heartbeat?.state) || !Number.isFinite(heartbeat.at) || Date.now() - heartbeat.at > RUNNER_HEARTBEAT_MAX_AGE_MS) {
      await chrome.offscreen.closeDocument();
      exists = false;
    }
  }
  if (!exists) {
    await setRunnerHeartbeat('starting', runnerDiagnostic(true, false, false, null));
    if (!offscreenCreation) {
      offscreenCreation = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['WORKERS', 'AUDIO_PLAYBACK'],
        justification: 'Keep the Field Browser Bridge command transport worker awake while control is enabled.'
      }).finally(() => { offscreenCreation = null; });
    }
    await offscreenCreation;
    exists = true;
    await setRunnerHeartbeat('starting', runnerDiagnostic(true, exists, false, null));
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'durable-runner-configure', brokerUrl: settings.brokerUrl, brokerToken: settings.brokerToken, controlEnabled: true, extensionVersion: extensionVersion(), swap: await swapStatus() });
    if (response?.ok === true && response.ready === true) return true;
  } catch { /* Fall back to the worker-owned recovery transport. */ }
  await setRunnerHeartbeat('failed', runnerDiagnostic(true, exists, true, 'failed'));
  return false;
}

export function ensureDurableCommandRunner() {
  if (!durableRunnerEnsure) {
    durableRunnerEnsure = ensureDurableCommandRunnerOnce().finally(() => { durableRunnerEnsure = null; });
  }
  return durableRunnerEnsure;
}

function isSafeRemoteNavigation(url) {
  return typeof url === 'string'
    && isCapturableUrl(url);
}

function waitForTabComplete(tabId, timeoutMs = NAVIGATION_COMPLETE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(completed);
    };
    const listener = (updatedTabId, change) => {
      if (updatedTabId === tabId && change.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function navigationReachedRequestedUrl(tabUrl, requestedUrl, startingUrl) {
  try {
    const current = new URL(tabUrl);
    const requested = new URL(requestedUrl);
    const normalizedPath = (value) => value.replace(/\/$/, '') || '/';
    const samePage = current.origin === requested.origin
      && normalizedPath(current.pathname) === normalizedPath(requested.pathname);
    // A same-origin redirect only counts when the tab actually left the page it started on.
    const sameOriginRedirect = current.origin === requested.origin && tabUrl !== startingUrl;
    return samePage || sameOriginRedirect;
  } catch {
    return false;
  }
}

// Agents only ever see page tokens and stand-ins; the real address is rebuilt here, on this machine.
async function realUrl(url) {
  if (!url || !(await privateBrowser())) return url;
  const state = await loadSwap();
  let value = String(url);
  try {
    const parsed = new URL(value);
    const token = `${parsed.origin}${parsed.pathname}`;
    const address = Object.entries(state.map.pages || {}).find(([, standIn]) => standIn === token)?.[0];
    if (address) value = `${address}${parsed.search}${parsed.hash}`;
  } catch { return url; }
  return restore(value, state.map);
}

async function navigateAndCapture(tab, command, checkOrigin = true, explicit = false) {
  command = { ...command, url: await realUrl(command.url) };
  if (!isSafeRemoteNavigation(command.url)) return { ok: false, error: 'Refused: remote navigation is limited to normal URLs and cannot be a final action.' };
  if (await targetChanged(tab, explicit, checkOrigin)) return targetChangedResult(tab, explicit);
  const startingUrl = tab.url;
  const completed = waitForTabComplete(tab.id);
  let updateRejected = false;
  try {
    await chrome.tabs.update(tab.id, { url: command.url });
  } catch {
    updateRejected = true;
  }
  const didComplete = await completed;
  let finalTab = null;
  if (updateRejected || !didComplete) {
    try { finalTab = await chrome.tabs.get(tab.id); } catch { /* The tab no longer exists. */ }
    const navigationReached = finalTab
      && navigationReachedRequestedUrl(finalTab.url, command.url, startingUrl)
      && (didComplete || finalTab.status === 'complete');
    if (!navigationReached) {
      if (updateRejected) return { ok: false, error: 'The browser did not open that page.' };
      return { ok: false, error: 'Navigation did not finish before the 10-second limit.' };
    }
  }
  finalTab ||= await currentTabOrNull(tab.id);
  const page = pageIdentity(finalTab || { ...tab, url: command.url });
  try {
    const captured = await captureTabForDelivery(finalTab || { ...tab, url: command.url }, true, false, explicit ? 'tab' : true);
    return { ok: true, result: { navigated: true, tabId: tab.id, page, captureDelivered: captured.sent, capture: captured.capture } };
  } catch (error) {
    return { ok: true, result: { navigated: true, tabId: tab.id, page, captureDelivered: false, captureError: error.message || 'Fresh capture delivery failed.' } };
  }
}

function screenshotIngestUrl(brokerUrl) {
  if (!validateBrokerUrl(brokerUrl)) return null;
  const endpoint = new URL(brokerUrl);
  endpoint.pathname = '/work-edge/ingest-screenshot';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

async function deliverScreenshot(screenshot) {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  const endpoint = screenshotIngestUrl(settings.brokerUrl);
  if (!endpoint || !settings.brokerToken) return false;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
      body: JSON.stringify(screenshot),
      cache: 'no-store'
    });
    return response.ok;
  } catch { return false; }
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUGGER_SCREENSHOT_TIMEOUT_MS = 8_000;

// Background-tab screenshots (approved in 2026-10-22). Chrome shows its
// "is debugging this browser" bar while attached; we detach right after.
export async function debuggerScreenshot(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
  } catch {
    throw new Error(`Could not attach to tab ${tabId} for a screenshot. Close DevTools on that tab if it is open, then try again.`);
  }
  let timer;
  try {
    const shot = await Promise.race([
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', fromSurface: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Tab ${tabId} did not render a screenshot in time. Chrome may be pausing that background tab.`)), DEBUGGER_SCREENSHOT_TIMEOUT_MS); })
    ]);
    if (typeof shot?.data !== 'string' || !shot.data) throw new Error(`Tab ${tabId} returned an empty screenshot.`);
    return `data:image/png;base64,${shot.data}`;
  } finally {
    clearTimeout(timer);
    await chrome.debugger.detach(target).catch(() => {});
  }
}

export async function screenshotActiveTab(tab, command, explicit = false) {
  if (await privateBrowser()) return { ok: false, code: 'private_browser', error: 'Screenshots are unavailable for private browsers.' };
  const durable = await chrome.storage.local.get(CONTROL_ENABLED_KEY);
  if (durable[CONTROL_ENABLED_KEY] !== true) return { ok: false, error: 'Control is not enabled.' };
  if (!tab?.id || !isCapturableTab(tab)) return { ok: false, error: 'Screenshot capture is limited to a normal web tab.' };
  if (typeof command?.id !== 'string' || !/^[a-f0-9]{16}$/.test(command.id)) return { ok: false, error: 'Screenshot command identity is invalid.' };
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['<all_urls>', 'http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) return { ok: false, error: 'Enable reading normal tabs before requesting a screenshot.' };
  const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
  if (restrict && isSensitivePage({ url: tab.url }) && !isApprovedOrigin(new URL(tab.url).origin, approvedSensitiveOrigins)) return { ok: false, error: 'Screenshot on a sensitive page requires explicit read approval.' };
  const selectedOrigin = tabOrigin(tab);
  const foregroundMatchesSelection = (front) => front?.id === tab.id
    && front.windowId === tab.windowId
    && tabOrigin(front) === selectedOrigin;
  let dataUrl;
  let capturedAt;
  if (explicit) {
    // A named tab is shot without bringing it to the front: the visible-tab
    // capture when it is already showing in its window, otherwise the debugger.
    if (await namedTabChanged(tab)) return namedTabChangedResult(tab);
    try {
      dataUrl = tab.active === true
        ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => debuggerScreenshot(tab.id))
        : await debuggerScreenshot(tab.id);
      capturedAt = new Date().toISOString();
    } catch (error) {
      return { ok: false, code: 'screenshot_unavailable', error: error?.message || `The screenshot of tab ${tab.id} could not be taken, so none was returned.` };
    }
    if (await namedTabChanged(tab)) return namedTabChangedResult(tab);
  } else {
    if (!foregroundMatchesSelection(await activeTab())) return tabChangedResult();
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      capturedAt = new Date().toISOString();
    } catch {
      return { ok: false, code: 'screenshot_unavailable', error: 'The screenshot could not be taken of your front tab, so none was returned.' };
    }
    if (!foregroundMatchesSelection(await activeTab())) return tabChangedResult();
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return { ok: false, error: 'Screenshot capture did not return a PNG data URL.' };
  if (new TextEncoder().encode(dataUrl).byteLength > MAX_SCREENSHOT_DATA_URL_BYTES) return { ok: false, error: 'Screenshot exceeds the 5 MB limit.' };
  const delivered = await deliverScreenshot({ commandId: command.id, dataUrl, tabId: tab.id, url: tab.url, capturedAt, mimeType: 'image/png' });
  if (!delivered) return { ok: false, error: 'The broker did not accept the screenshot.' };
  return { ok: true, result: { tabId: tab.id, windowId: tab.windowId, origin: selectedOrigin, capturedAt, mimeType: 'image/png', screenshotDelivered: true } };
}

function shouldCaptureAfterCommand(command, outcome) {
  return outcome?.ok === true && ['click', 'press', 'type', 'select', 'scroll', 'wait'].includes(command?.type);
}

async function captureAfterCommand(tab, command, outcome, explicit = false) {
  if (!shouldCaptureAfterCommand(command, outcome)) return outcome;
  if (command.type === 'click' || command.type === 'press') await new Promise((resolve) => setTimeout(resolve, PAGE_STATE_CAPTURE_SETTLE_MS));

  // Re-read the active tab after the action: an SPA may have updated its title
  // or route without emitting a normal navigation-load event.
  const refreshedTab = explicit ? await chrome.tabs.get(tab.id).catch(() => null) : await activeTab();
  if (!refreshedTab?.id || refreshedTab.id !== tab.id || !isCapturableTab(refreshedTab)) return outcome;
  // Agent actions always return a fresh read of the same tab (2026-10-22), even
  // with background read monitoring off. Sensitive-page rules still apply inside capture.
  const agentAction = typeof command?.agentId === 'string' && command.agentId.length > 0;
  const monitoring = await chrome.storage.local.get(READ_MONITORING_ENABLED_KEY);
  if ((!agentAction && monitoring[READ_MONITORING_ENABLED_KEY] === false) || !autoCaptureEligibility(refreshedTab).allowed) return outcome;

  try {
    const captured = await captureTabForDelivery(refreshedTab, true, false, explicit ? 'tab' : true);
    return { ...outcome, result: { ...(outcome.result || {}), page: pageIdentity(refreshedTab), captureDelivered: captured.sent, capture: captured.capture } };
  } catch (error) {
    // The action happened. Report delivery failure separately rather than
    // falsely reporting that the command itself failed.
    return { ...outcome, result: { ...(outcome.result || {}), captureDelivered: false, captureError: error.message || 'Fresh capture delivery failed.' } };
  }
}

async function consumeSingleClickBinding(command, tab) {
  const binding = command.approvalBinding;
  const key = `singleClick:${binding.token}`;
  const stored = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  const samePage = (left, right) => {
    try { const a = new URL(left); const b = new URL(right); return a.origin === b.origin && a.pathname === b.pathname; }
    catch { return left === right; }
  };
  if (!stored || stored.expiresAt <= Date.now() || stored.tabId !== tab.id || stored.transactionId !== binding.transactionId
    || JSON.stringify(stored.target) !== JSON.stringify(command.target || null) || stored.name !== binding.name
    || stored.tag !== binding.tag || stored.ref !== binding.ref || stored.fingerprint !== binding.fingerprint || !samePage(stored.url, binding.url)
    || (stored.requestedUrl || null) !== (binding.requestedUrl || null) || (binding.requestedUrl || null) !== (command.url || null)
    || !samePage(stored.url, tab.url ?? tab.pendingUrl ?? '')) {
    return 'The page changed; nothing was clicked.';
  }
  if (['navigate', 'open_tab'].includes(command.type) && isCapturableTab(tab)) {
    try {
      const [inspection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: executeBrowserCommand,
        args: [{ type: 'inspect_action', finalNavigation: true, url: command.url }] });
      if (!inspection?.result?.ok || inspection.result.result.fingerprint !== stored.fingerprint
        || !samePage(inspection.result.result.url, stored.url)) return 'The page changed; nothing was clicked.';
    } catch { return 'The page changed; nothing was clicked.'; }
  }
  return null;
}

async function executeCommandInActiveTabRaw(command) {
  if (typeof command?.agentId === 'string' && command.agentId) {
    chrome.storage.session.set({ lastActingAgent: { agentId: command.agentId.slice(0, 100), at: Date.now() } }).catch(() => {});
  }
  const durable = await chrome.storage.local.get(CONTROL_ENABLED_KEY);
  if (durable[CONTROL_ENABLED_KEY] !== true) return { ok: false, error: 'Control is not enabled.' };
  if (command?.type === 'list_tabs') return listOpenTabs();
  if (command?.type === 'open_tab') {
    if (command.finalAction && command.askBeforeFinalActions !== false && !command.approvalBinding) return { ok: false, error: 'Approval required before opening this final-action URL.' };
    if (command.approvalBinding) {
      const selected = await resolveCommandTab(command);
      if (selected.error) return selected.error;
      const error = await consumeSingleClickBinding(command, selected.tab);
      if (error) return { ok: false, error };
    }
    return openTab(command);
  }
  const resolved = await resolveCommandTab(command);
  if (resolved.error) return resolved.error;
  const { tab, explicit } = resolved;
  if (command?.type === 'navigate' && command.finalAction && command.askBeforeFinalActions !== false && !command.approvalBinding) return { ok: false, error: 'Approval required before opening this final-action URL.' };
  if (command?.approvalBinding) {
    const error = await consumeSingleClickBinding(command, tab);
    if (error) return { ok: false, error };
  }
  if (['read_tab', 'activate_tab', 'close_tab'].includes(command?.type) && !explicit) return { ok: false, code: 'tab_invalid', error: 'This command needs a tabId from edge_list_open_tabs.' };
  if (command?.type === 'activate_tab') return activateTab(tab);
  if (command?.type === 'close_tab') return closeTab(tab);
  if (command?.type === 'read_tab') return readTab(tab, command.maxCharacters);
  if (command?.type === 'inspect_action' && command.finalNavigation && tab?.id && isEmptyTabUrl(tab.url ?? tab.pendingUrl ?? '')) {
    const url = tab.url ?? tab.pendingUrl ?? '';
    const result = { finalAction: true, name: command.url, fingerprint: `empty:${url}`,
      url, title: tab.title || '', requestedUrl: command.url, tabId: tab.id };
    await chrome.storage.session.set({ [`singleClick:${command.approvalToken}`]: { ...result, transactionId: command.transactionId,
      target: null, expiresAt: Math.min(Number(command.approvalExpiresAt) || 0, Date.now() + 610_000) } });
    return { ok: true, result };
  }
  if (command?.type === 'navigate' && tab?.id && isEmptyTabUrl(tab.url ?? tab.pendingUrl ?? '')) {
    // Approved exception (2026-10-14): move an empty tab. Since 2026-10-22 a named background tab may be moved too.
    return navigateAndCapture(tab, command, false, explicit);
  }
  if (!tab?.id || !isCapturableTab(tab)) {
    return explicit
      ? { ok: false, error: `Tab ${tab?.id} isn't a normal web page, so nothing was done.` }
      : { ok: false, error: "Your front tab isn't a normal web page, so nothing was done. Switch to the page you want and try again." };
  }
  if (['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type) && command.expectedTabId !== undefined) {
    if (tab.id !== command.expectedTabId || new URL(tab.url).origin !== command.expectedOrigin) return { ok: false, error: 'The active tab no longer matches the approved verified-action target.' };
  }
  if (command?.type === 'navigate') return navigateAndCapture(tab, command, true, explicit);
  if (command?.type === 'screenshot') return screenshotActiveTab(tab, command, explicit);
  if (await targetChanged(tab, explicit)) return targetChangedResult(tab, explicit);
  let seenCommand = command;
  if (await privateBrowser() && command?.seenPages) {
    const pages = (await loadSwap()).map.pages || {};
    const address = listedAddress(tab.url);
    if (pages[address] && command.seenPages[String(tab.id)] === pages[address]) {
      seenCommand = { ...command, seenPages: { ...command.seenPages, [String(tab.id)]: address } };
    }
  }
  if (!agentHasSeenPage(seenCommand, tab)) return lookFirstResult(tab, explicit);
  let frameId = 0;
  let framedCommand = command;
  try {
    const targets = ['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type)
      ? [...(command.steps || []).map((step) => step.locator), ...(command.commit ? [command.commit] : [])]
      : command?.type === 'find' ? [{ selector: command.selector }] : [command?.target];
    const ids = new Set();
    const stripped = targets.map((target) => {
      if (!target) return target;
      const key = ['ref', 'selector', 'targetText'].find((name) => typeof target[name] === 'string');
      if (!key) return target;
      const parsed = parseFrameTarget(target[key]);
      ids.add(parsed.frameId);
      return { ...target, [key]: parsed.value };
    });
    if (ids.size > 1) return { ok: false, error: 'A command must target one frame; mixed frame targets were refused.' };
    frameId = [...ids][0] || 0;
    if (frameId) {
      const stored = (await chrome.storage.session.get(CAPTURE_KEY))[CAPTURE_KEY];
      const expected = isFreshCaptureForTab(stored, tab) && stored.frameContexts?.find((frame) => frame.frameId === frameId);
      if (!expected) return { ok: false, error: `Frame ${frameId} is stale or was not included in the last readable capture. Read the tab again.` };
      let current;
      try {
        const results = await captureFrames({ tabId: tab.id, frameIds: [frameId] });
        current = results[0]?.result;
      } catch { return { ok: false, error: `Frame ${frameId} is stale or unavailable. Read the tab again.` }; }
      if (!current?.url || current.url !== expected.url) return { ok: false, error: `Frame ${frameId} changed since the last capture. Read the tab again.` };
      if (command?.type === 'find') {
        const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
        if (restrict && (expected.sensitive || isSensitivePage(current)) && !isApprovedOrigin(expected.origin, approvedSensitiveOrigins)) return { ok: false, error: 'Live discovery on a sensitive frame requires sensitive-read approval.' };
      }
    }
    if (['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type)) framedCommand = { ...command, steps: command.steps.map((step, index) => ({ ...step, locator: stripped[index] })), ...(command.commit ? { commit: stripped.at(-1) } : {}) };
    else if (command?.type === 'find') framedCommand = { ...command, selector: stripped[0]?.selector };
    else if (command?.target) framedCommand = { ...command, target: stripped[0] };
  } catch (error) { return { ok: false, error: error.message }; }
  if (command?.type === 'find' && !frameId) {
    const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
    if (restrict && isSensitivePage({ url: tab.url }) && !isApprovedOrigin(new URL(tab.url).origin, approvedSensitiveOrigins)) return { ok: false, error: 'Live discovery on a sensitive page requires sensitive-read approval.' };
  }
  if (await privateBrowser() && ['type', 'select', 'fill'].includes(command?.type)) {
    const map = (await loadSwap()).map;
    framedCommand = { ...framedCommand,
      ...(typeof framedCommand.text === 'string' ? { text: restore(framedCommand.text, map) } : {}),
      ...(typeof framedCommand.value === 'string' ? { value: restore(framedCommand.value, map) } : {}),
      ...(typeof framedCommand.optionText === 'string' ? { optionText: restore(framedCommand.optionText, map) } : {}) };
  }
  const executor = ['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type) ? executeVerifiedActionCommand : executeBrowserCommand;
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, ...(frameId ? { frameIds: [frameId] } : {}) }, func: executor, args: [framedCommand] });
  } catch (error) { return { ok: false, error: frameId ? `Frame ${frameId} is stale or unavailable. Read the tab again.` : (error.message || 'Command execution failed.') }; }
  const outcome = result || { ok: false, error: 'Command returned no result.' };
  if (outcome.ok && command?.type === 'inspect_action' && outcome.result?.finalAction && command.approvalToken) {
    const binding = { ...outcome.result, transactionId: command.transactionId, target: outcome.result.ref ? { ref: outcome.result.ref } : command.target || null, tabId: tab.id,
      expiresAt: Math.min(Number(command.approvalExpiresAt) || 0, Date.now() + 610_000) };
    await chrome.storage.session.set({ [`singleClick:${command.approvalToken}`]: binding });
  }
  if (outcome.ok && command?.type === 'inspect_action') outcome.result.tabId = tab.id;
  if (outcome.ok && command?.type === 'find' && frameId) for (const match of outcome.result?.matches || []) if (match.ref) match.ref = scopeFrameRef(frameId, match.ref);
  if (outcome.ok && ['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type)) {
    outcome.result = { ...(outcome.result || {}), tabId: tab.id, origin: new URL(tab.url).origin };
  }
  return captureAfterCommand(tab, command, outcome, explicit);
}

export async function executeCommandInActiveTab(command) {
  const outcome = await executeCommandInActiveTabRaw(command);
  if (!await privateBrowser()) return outcome;
  return (await scrubPayload(outcome)).clean;
}

function lookFirstPayload(outcome) { return outcome?.code === 'look_first' ? { page: outcome.page, capture: outcome.capture } : undefined; }
function scheduleSocketReconnect() { if (socketRetryTimer) return; const delay = Math.min(30_000, 500 * (2 ** socketRetry++)); socketRetryTimer = setTimeout(() => { socketRetryTimer = null; resumeCommandTransport(); }, delay); }
function socketIsOpen(socket = brokerSocket) { return typeof WebSocket !== 'undefined' && socket?.readyState === WebSocket.OPEN; }
async function ensureBrokerSocket() {
  if (typeof WebSocket === 'undefined') return;
  if (socketConnecting || brokerSocket?.readyState === WebSocket.OPEN || brokerSocket?.readyState === WebSocket.CONNECTING) return;
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', CONTROL_ENABLED_KEY, COMMAND_RESUME_KEY]);
  if (!settings.brokerToken || settings[CONTROL_ENABLED_KEY] !== true || !validateBrokerUrl(settings.brokerUrl)) return;
  const endpoint = websocketEndpointUrl(settings.brokerUrl); if (!endpoint) return;
  socketConnecting = true;
  try {
    const socket = new WebSocket(endpoint); brokerSocket = socket;
    const connectTimeout = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 10_000);
    socket.onopen = async () => { clearTimeout(connectTimeout); socketConnecting = false; socketRetry = 0; const [resumeState, controlState] = await Promise.all([chrome.storage.local.get(COMMAND_RESUME_KEY), chrome.storage.local.get(CONTROL_ENABLED_KEY)]); const resume = resumeState[COMMAND_RESUME_KEY] || {}; socket.send(JSON.stringify({ type: 'hello', token: settings.brokerToken, controlEnabled: controlState[CONTROL_ENABLED_KEY] === true, extensionVersion: extensionVersion(), swap: await swapStatus(), lastReceivedSeq: Number(resume.lastReceivedSeq) || 0, lastCompletedSeq: Number(resume.lastCompletedSeq) || 0 })); chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'websocket', at: Date.now() } }); socketKeepaliveTimer = setInterval(async () => { if (socket.readyState === WebSocket.OPEN) { const state = await chrome.storage.local.get(CONTROL_ENABLED_KEY); socket.send(JSON.stringify({ type: 'keepalive', controlEnabled: state[CONTROL_ENABLED_KEY] === true, swap: await swapStatus() })); } }, SOCKET_KEEPALIVE_MS); };
    socket.onmessage = (event) => handleBrokerSocketMessage(socket, event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => { clearTimeout(connectTimeout); clearInterval(socketKeepaliveTimer); socketKeepaliveTimer = null; socketConnecting = false; if (brokerSocket === socket) brokerSocket = null; recoverCommandTransport().catch(() => {}); scheduleSocketReconnect(); };
  } catch { socketConnecting = false; recoverCommandTransport().catch(() => {}); scheduleSocketReconnect(); }
}
async function handleBrokerSocketMessage(socket, raw) {
  let message; try { message = JSON.parse(raw); } catch { return; }

  if (['hello', 'keepalive'].includes(message.type) && message.ok === true && message.browser && typeof message.browser.id === 'string' && typeof message.browser.name === 'string') {
    await chrome.storage.session.set({ browserIdentity: { id: message.browser.id.slice(0, 40), name: message.browser.name.slice(0, 60), isDefault: message.browser.isDefault === true, private: message.browser.private === true } });
    return;
  }
  if (message.type !== 'command' || !message.command || !Number.isInteger(message.seq)) return;
  // Receipt is intentionally sent before command execution. It distinguishes a
  // live command consumer from a stale socket that can still carry keepalives.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'command-received', id: message.command.id, seq: message.seq }));
  const resume = (await chrome.storage.local.get(COMMAND_RESUME_KEY))[COMMAND_RESUME_KEY] || {};
  await chrome.storage.local.set({ [COMMAND_RESUME_KEY]: { lastReceivedSeq: Math.max(Number(resume.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Number(resume.lastCompletedSeq) || 0 } });
  const outcome = await executeCommandInActiveTab(message.command).catch((error) => ({ ok: false, error: error.message }));
  const current = (await chrome.storage.local.get(COMMAND_RESUME_KEY))[COMMAND_RESUME_KEY] || {};
  await chrome.storage.local.set({ [COMMAND_RESUME_KEY]: { lastReceivedSeq: Math.max(Number(current.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Math.max(Number(current.lastCompletedSeq) || 0, message.seq) } });
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'result', id: message.command.id, ok: outcome.ok === true, result: outcome.result ?? (outcome.candidates ? { candidates: outcome.candidates } : lookFirstPayload(outcome)), error: outcome.error, code: outcome.code, lastReceivedSeq: Math.max(Number(current.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Math.max(Number(current.lastCompletedSeq) || 0, message.seq) }));
  else startCommandPolling();
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  // Service-worker termination can close the WebSocket without executing its
  // close handler. A persistent alarm wakes the worker and resumes its
  // authenticated recovery transport without needing the popup to be open.
  chrome.alarms.create(COMMAND_TRANSPORT_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== COMMAND_TRANSPORT_ALARM) return;
    resumeCommandTransport();
  });
}
if (typeof chrome !== 'undefined' && chrome.runtime?.id) resumeCommandTransport();
async function submitCommandResult(settings, command, outcome) {
  await fetch(commandEndpoint(settings.brokerUrl, 'result'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify({ id: command.id, ok: outcome.ok === true, result: outcome.result ?? (outcome.candidates ? { candidates: outcome.candidates } : lookFirstPayload(outcome)), error: outcome.error, code: outcome.code }), cache: 'no-store' });
}
async function startCommandPolling() {
  if (commandPolling) return;
  commandPolling = true;
  try {
    while (true) {
      const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', CONTROL_ENABLED_KEY]);
      if (!settings.brokerToken || !validateBrokerUrl(settings.brokerUrl) || settings[CONTROL_ENABLED_KEY] !== true) break;
      if (socketIsOpen()) break;
      let response;
      try { response = await fetch(commandEndpoint(settings.brokerUrl, 'poll'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify({ waitMs: 25_000, controlEnabled: true, extensionVersion: extensionVersion() }), cache: 'no-store' }); } catch {
        await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'failed', at: Date.now() } });
        break;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'failed', at: Date.now() } });
        break;
      }
      await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'active', at: Date.now() } });
      if (!payload.command) continue;
      const outcome = await executeCommandInActiveTab(payload.command).catch((error) => ({ ok: false, error: error.message }));
      await submitCommandResult(settings, payload.command, outcome).catch(() => {});
    }
  } finally { commandPolling = false; }
}

// An MV3 worker may be suspended after a socket close, losing in-memory retry
// timers. The authenticated long poll is the durable recovery transport until
// a new WSS connection takes over.
export async function recoverCommandTransport() {
  const settings = await chrome.storage.local.get(CONTROL_ENABLED_KEY);
  if (settings[CONTROL_ENABLED_KEY] !== true || socketIsOpen()) return;
  return startCommandPolling();
}

// Call this on every durable wake, toggle-on, and retry. The authenticated poll
// starts immediately rather than waiting for a WebSocket close callback that an
// MV3 suspension may never run; a healthy WebSocket takes over on its own.
export function resumeCommandTransport() {
  // The offscreen runner is the sole command transport owner. Falling back to
  // this service worker would create competing authenticated sockets after a
  // context restart and can duplicate delivery of a durable queue record.
  return ensureDurableCommandRunner();
}

export { normalizeBrokerUrl, validateBrokerUrl };
