import { HOSTED_COCKPIT_URL } from './hosted-default.js';

// Side panel Chat view (approved in 2026-10-22): the side panel shows the
// same Field Browser Cockpit used on phone and desktop instead of a second chat,
// so there is one conversation, one agent picker, and one approvals queue.
const COCKPIT_URL_KEY = 'cockpitUrl';
const PANEL_VIEW_KEY = 'sidePanelView';
if (typeof document !== 'undefined') document.querySelector('#enableLocalDisplay')?.addEventListener('click', async () => {
  const status = document.querySelector('#privacySummary');
  try {
    const url = await storedCockpitUrl();
    const origin = new URL(url).origin;
    const allowed = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!allowed) throw new Error('Cockpit page access was not allowed.');
    const result = await chrome.runtime.sendMessage({ type: 'swap-register-display', origin });
    if (!result.ok) throw new Error(result.error);
    status.textContent = 'Real details are shown in Cockpit on this computer.';
  } catch (error) { status.textContent = error.message; }
});

export function validCockpitUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function elements() {
  return {
    chatTab: document.getElementById('showChat'),
    bridgeTab: document.getElementById('showBridge'),
    chatView: document.getElementById('chatView'),
    bridgeView: document.getElementById('bridgeView'),
    frame: document.getElementById('cockpitFrame'),
    retryStatus: document.getElementById('chatRetryStatus'),
    reload: document.getElementById('reloadChat'),
    input: document.getElementById('cockpitUrl'),
    save: document.getElementById('saveCockpit'),
    status: document.getElementById('cockpitStatus')
  };
}

async function storedCockpitUrl() {
  try { return validCockpitUrl((await chrome.storage.local.get(COCKPIT_URL_KEY))[COCKPIT_URL_KEY]) || HOSTED_COCKPIT_URL; }
  catch { return HOSTED_COCKPIT_URL; }
}

export function createChatLoader(ui, { fetch, setTimeout, clearTimeout, now = () => Date.now() }) {
  let timer = null;
  let generation = 0;
  let started = 0;
  let failures = 0;
  let healthy = false;
  let url = '';
  const retryDelays = [2000, 4000, 8000];
  const clearRetry = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const retry = (current) => {
    if (now() - started >= 300000) return;
    const delay = retryDelays[failures - 1] || 15000;
    if (now() - started + delay > 300000) return;
    timer = setTimeout(() => probe(current), delay);
  };
  const probe = async (current) => {
    if (current !== generation) return;
    try {
      const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit' });
      if (current !== generation) return;
      if (response.status >= 500) throw new Error('Cockpit unavailable');
      ui.retryStatus.hidden = true;
      ui.frame.src = url;
      ui.frame.dataset.loaded = url;
      healthy = false;
    } catch {
      if (current !== generation) return;
      failures++;
      ui.frame.dataset.loaded = '';
      ui.retryStatus.textContent = 'Cockpit is restarting. Trying again…';
      ui.retryStatus.hidden = false;
      retry(current);
    }
  };
  ui.frame.addEventListener('load', () => { healthy = true; ui.retryStatus.hidden = true; });
  ui.frame.addEventListener('error', () => {
    if (!url) return;
    healthy = false;
    ui.frame.dataset.loaded = '';
    ui.retryStatus.textContent = 'Cockpit is restarting. Trying again…';
    ui.retryStatus.hidden = false;
    clearRetry();
    failures = 1;
    retry(generation);
  });
  return (nextUrl, force = false) => {
    if (!force && nextUrl === url && (healthy || timer !== null || ui.frame.dataset.loaded === url)) return;
    clearRetry();
    url = nextUrl;
    generation++;
    started = now();
    failures = 0;
    healthy = false;
    ui.frame.dataset.loaded = '';
    probe(generation);
  };
}

async function show(ui, view, loadFrame) {
  const chat = view !== 'bridge';
  ui.chatView.hidden = !chat;
  ui.bridgeView.hidden = chat;
  ui.chatTab.setAttribute('aria-selected', String(chat));
  ui.bridgeTab.setAttribute('aria-selected', String(!chat));
  if (chat) loadFrame(await storedCockpitUrl());
  try { await chrome.storage.local.set({ [PANEL_VIEW_KEY]: chat ? 'chat' : 'bridge' }); } catch { /* Remembering the view is a convenience. */ }
}

export async function initCockpitPanel() {
  const ui = elements();
  if (!ui.chatTab || !ui.frame) return;
  const loadFrame = createChatLoader(ui, { fetch: globalThis.fetch.bind(globalThis), setTimeout, clearTimeout });
  ui.input.value = await storedCockpitUrl();
  ui.chatTab.addEventListener('click', () => show(ui, 'chat', loadFrame));
  ui.bridgeTab.addEventListener('click', () => show(ui, 'bridge', loadFrame));
  ui.reload.addEventListener('click', () => loadFrame(ui.input.value, true));
  ui.save.addEventListener('click', async () => {
    const url = validCockpitUrl(ui.input.value);
    if (!url) { ui.status.textContent = 'Use an HTTPS address, or HTTP on localhost.'; return; }
    await chrome.storage.local.set({ [COCKPIT_URL_KEY]: url });
    loadFrame(url, true);
    ui.status.textContent = 'Cockpit address saved.';
  });
  let view = 'chat';
  try { view = (await chrome.storage.local.get(PANEL_VIEW_KEY))[PANEL_VIEW_KEY] === 'bridge' ? 'bridge' : 'chat'; } catch { /* Default to chat. */ }
  if (new URLSearchParams(location.search).get('view') === 'bridge') view = 'bridge';
  await show(ui, view, loadFrame);
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) initCockpitPanel();
