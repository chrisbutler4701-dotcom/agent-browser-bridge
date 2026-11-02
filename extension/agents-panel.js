import { HOSTED_INGEST_URL } from './hosted-default.js';

const OWNER_SESSION_KEY = 'ownerSession';
const PERMISSION_LABELS = Object.freeze({
  'browser.read': 'Can read pages',
  'browser.control': 'Can control the browser',
  'browser.verified.propose': 'Can propose verified actions',
  'browser.verified.execute': 'Can execute approved verified actions',
  'browser.audit.read': 'Can read audit history'
});

function ownerBase(brokerUrl) {
  try { return new URL(brokerUrl || HOSTED_INGEST_URL).origin; }
  catch { return ''; }
}

export function initializeAgentsPanel({ document, chrome, fetch, navigator }) {
  const signedOut = document.querySelector('#agentsSignedOut');
  const passphrase = document.querySelector('#ownerPassphrase');
  const signIn = document.querySelector('#ownerSignIn');
  const signedIn = document.querySelector('#agentsSignedIn');
  const preset = document.querySelector('#agentPreset');
  const propose = document.querySelector('#allowVerifiedPropose');
  const execute = document.querySelector('#allowVerifiedExecute');
  const connect = document.querySelector('#connectAgent');
  const result = document.querySelector('#agentResult');
  const list = document.querySelector('#agentsList');
  const pair = document.querySelector('#pairFromOwner');
  const pairChoices = document.querySelector('#ownerPairChoices');
  const signOut = document.querySelector('#ownerSignOut');
  const status = document.querySelector('#agentsStatus');
  let baseUrl = ownerBase();
  let sessionToken = null;
  let mcpUrl = `${baseUrl}/mcp`;

  function showSignedOut(message = 'Sign in with your owner passphrase to manage agents.') {
    sessionToken = null;
    signedOut.hidden = false;
    signedIn.hidden = true;
    result.replaceChildren();
    pairChoices?.replaceChildren();
    if (pairChoices) pairChoices.hidden = true;
    status.textContent = message;
  }

  function showSignedIn() {
    signedOut.hidden = true;
    signedIn.hidden = false;
  }

  async function forgetSession(message) {
    await chrome.storage.session.remove(OWNER_SESSION_KEY);
    showSignedOut(message || 'Sign in again with your owner passphrase.');
  }

  async function ownerRequest(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
    const response = await fetch(`${baseUrl}/work-edge/owner/${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await forgetSession(payload.error || 'Sign in again with your owner passphrase.');
      const error = new Error(payload.error || 'Sign in again with your owner passphrase.');
      error.sessionExpired = true;
      throw error;
    }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  function renderCopy(value, { oneTime = false } = {}) {
    result.replaceChildren();
    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.value = value;
    textarea.setAttribute('aria-label', oneTime ? 'One-time agent setup' : 'MCP URL');
    const copy = document.createElement('button');
    copy.className = 'button secondary';
    copy.type = 'button';
    copy.textContent = 'Copy';
    const copyStatus = document.createElement('p');
    copyStatus.setAttribute('role', 'status');
    if (oneTime) {
      const warning = document.createElement('p');
      warning.className = 'approval-note';
      warning.textContent = "Copy this now. It won't be shown again.";
      result.append(textarea, copy, warning, copyStatus);
    } else result.append(textarea, copy, copyStatus);
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(value);
      copyStatus.textContent = 'Copied.';
    });
  }

  function renderAgents(agents, webApps, approvers) {
    list.replaceChildren();
    const entries = [
      ...agents.filter((agent) => !agent.revokedAt).map((agent) => ({ ...agent, kind: 'agent', name: agent.id })),
      ...webApps.map((app) => ({ ...app, kind: 'web-app', name: app.displayName }))
    ];
    const approvalApps = approvers.filter((approver) => !approver.revokedAt);
    if (!entries.length && !approvalApps.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No agents connected yet.';
      list.append(empty);
      return;
    }
    const renderEntry = (entry) => {
      const row = document.createElement('div');
      const name = document.createElement('p');
      name.textContent = entry.name;
      const permissions = document.createElement('p');
      permissions.textContent = entry.kind === 'approver'
        ? 'Can approve or reject verified actions'
        : entry.capabilities.map((capability) => PERMISSION_LABELS[capability] || capability).join(' · ');
      const disconnect = document.createElement('button');
      disconnect.className = 'button danger';
      disconnect.type = 'button';
      disconnect.textContent = 'Disconnect';
      disconnect.addEventListener('click', async () => {
        disconnect.disabled = true;
        try {
          const path = entry.kind === 'web-app' ? 'web-apps/revoke' : entry.kind === 'approver' ? 'approvers/revoke' : 'agents/revoke';
          const payload = entry.kind === 'web-app' ? { clientId: entry.clientId } : { id: entry.id };
          await ownerRequest(path, { method: 'POST', body: payload });
          status.textContent = `${entry.name} disconnected.`;
          await refreshAgents();
        } catch (error) {
          if (!error.sessionExpired) status.textContent = error.message;
          disconnect.disabled = false;
        }
      });
      row.append(name, permissions, disconnect);
      list.append(row);
    };
    for (const entry of entries) renderEntry(entry);
    if (approvalApps.length) {
      const heading = document.createElement('p');
      heading.textContent = 'Approval apps';
      list.append(heading);
      for (const approver of approvalApps) renderEntry({ ...approver, kind: 'approver', name: approver.label });
    }
  }

  async function refreshPairing() {
    const pairing = await chrome.runtime.sendMessage({ type: 'broker-status' });
    pair.hidden = pairing?.paired === true;
  }

  async function refreshAgents() {
    const connected = await ownerRequest('agents');
    mcpUrl = connected.mcpUrl;
    renderAgents(connected.agents || [], connected.webApps || [], connected.approvers || []);
    await refreshPairing();
    return connected;
  }

  signIn.addEventListener('click', async () => {
    signIn.disabled = true;
    try {
      const suppliedPassphrase = passphrase.value;
      const response = await fetch(`${baseUrl}/work-edge/owner/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: suppliedPassphrase }), cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      passphrase.value = '';
      if (!response.ok) throw new Error(payload.error || `Sign-in failed (${response.status}).`);
      sessionToken = payload.token;
      await chrome.storage.session.set({ [OWNER_SESSION_KEY]: { token: payload.token, expiresAt: payload.expiresAt } });
      showSignedIn();
      await refreshAgents();
      status.textContent = 'Signed in. Choose an agent to connect.';
    } catch (error) { showSignedOut(error.message); }
    finally { signIn.disabled = false; }
  });

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      if (preset.value === 'claude-ai' || preset.value === 'chatgpt') {
        renderCopy(mcpUrl);
        status.textContent = 'Copy the MCP URL. When the app asks, sign in with your server passphrase.';
      } else {
        const capabilities = ['browser.read', 'browser.control'];
        if (propose.checked) capabilities.push('browser.verified.propose');
        if (execute.checked) capabilities.push('browser.verified.execute');
        const created = await ownerRequest('agents', { method: 'POST', body: { preset: preset.value, capabilities } });
        renderCopy(created.setup.text, { oneTime: true });
        await refreshAgents();
        status.textContent = `${created.id} connected.`;
      }
    } catch (error) { if (!error.sessionExpired) status.textContent = error.message; }
    finally { connect.disabled = false; }
  });

  async function completePairing(replacesBrowserId) {
    pairChoices.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const created = await ownerRequest('pair', { method: 'POST', body: replacesBrowserId ? { replacesBrowserId } : {} });
      const paired = await chrome.runtime.sendMessage({ type: 'pair-browser', code: created.code });
      if (!paired?.ok) throw new Error(paired?.error || 'Pairing was not accepted.');
      pair.hidden = true;
      pairChoices.hidden = true;
      const pairingCard = document.querySelector('#pairingCard');
      if (pairingCard) pairingCard.hidden = true;
      status.textContent = 'This browser is paired.';
    } catch (error) { if (!error.sessionExpired) status.textContent = error.message; }
    finally { pairChoices.querySelectorAll('button').forEach((button) => { button.disabled = false; }); }
  }

  pair.addEventListener('click', async () => {
    pair.disabled = true;
    pairChoices.replaceChildren();
    try {
      const { browsers = [] } = await ownerRequest('browsers');
      const offline = browsers.filter((browser) => browser.online === false);
      for (const browser of offline) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'button secondary';
        choice.textContent = `Replace ${browser.name} (keeps its settings, including Private)`;
        choice.addEventListener('click', () => completePairing(browser.id));
        pairChoices.append(choice);
      }
      const newBrowser = document.createElement('button');
      newBrowser.type = 'button';
      newBrowser.className = 'button secondary';
      newBrowser.textContent = 'Pair as a new browser';
      newBrowser.addEventListener('click', () => completePairing());
      pairChoices.append(newBrowser);
      pairChoices.hidden = false;
      (offline.length ? pairChoices.children[0] : newBrowser).focus();
    } catch (error) { if (!error.sessionExpired) status.textContent = error.message; }
    finally { pair.disabled = false; }
  });

  signOut.addEventListener('click', async () => {
    try { await ownerRequest('session', { method: 'DELETE' }); } catch (error) { if (!error.sessionExpired) status.textContent = error.message; }
    await forgetSession('Signed out.');
  });

  const ready = (async () => {
    const [settings, storedSession] = await Promise.all([
      chrome.storage.local.get(['brokerUrl']),
      chrome.storage.session.get([OWNER_SESSION_KEY])
    ]);
    baseUrl = ownerBase(settings.brokerUrl);
    mcpUrl = `${baseUrl}/mcp`;
    sessionToken = storedSession[OWNER_SESSION_KEY]?.token || null;
    if (!sessionToken) { showSignedOut(); return; }
    showSignedIn();
    try { await refreshAgents(); status.textContent = 'Signed in. Choose an agent to connect.'; }
    catch (error) { if (!error.sessionExpired) status.textContent = error.message; }
  })();

  return { ready, refreshAgents };
}

if (typeof document !== 'undefined' && document.querySelector('#agentsCard') && typeof chrome !== 'undefined') {
  initializeAgentsPanel({ document, chrome, fetch: globalThis.fetch.bind(globalThis), navigator: globalThis.navigator });
}
