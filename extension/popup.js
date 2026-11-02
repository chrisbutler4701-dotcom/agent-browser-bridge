import { normalizeBrokerUrl, validateBrokerUrl } from './service-worker.js';
import { describeAgentControl } from './agent-control-status.js';

document.querySelector('#extensionVersion').textContent = `Extension ${chrome.runtime.getManifest().version}`;
const privacySection = document.querySelector('#privacySection');
chrome.runtime.sendMessage({ type: 'swap-state' }).then((state) => {
  privacySection.hidden = state.private !== true;
  if (state.private) document.querySelector('#privacySummary').textContent = `${state.swap?.rosterCount || 0} clients on this computer. Identifier rules ${state.swap?.active ? 'active' : 'unavailable'}.`;
}).catch(() => {});
document.querySelector('#openPrivacy')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

const status = document.querySelector('#status');
const pageTitle = document.querySelector('#pageTitle');
const captureButton = document.querySelector('#capture');
const brokerUrl = document.querySelector('#brokerUrl');
const saveBroker = document.querySelector('#saveBroker');
const pairCode = document.querySelector('#pairCode');
const pairBrowser = document.querySelector('#pairBrowser');
const resetPairing = document.querySelector('#resetPairing');
const pairStatus = document.querySelector('#pairStatus');
const pairingCard = document.querySelector('#pairingCard');
const setupCard = document.querySelector('#setupCard');
if (setupCard && new URLSearchParams(location.search).get('setup') === '1') {
  setupCard.hidden = false;
  pairCode.focus();
}
const toggleBrowserControl = document.querySelector('#toggleBrowserControl');
const armStatus = document.querySelector('#armStatus');
const browserIdentity = document.querySelector('#browserIdentity');
const agentControlStatus = document.querySelector('#agentControlStatus');
const enableReading = document.querySelector('#enableReading');
const readApproval = document.querySelector('#readApproval');
const restrictSensitiveRead = document.querySelector('#restrictSensitiveRead');
const allowSensitiveRead = document.querySelector('#allowSensitiveRead');
const forgetSensitiveRead = document.querySelector('#forgetSensitiveRead');
const sensitiveReadStatus = document.querySelector('#sensitiveReadStatus');
const readMonitoring = document.querySelector('#readMonitoring');
const readEditableText = document.querySelector('#readEditableText');
const verifiedApprovalCard = document.querySelector('#verifiedApprovalCard');
const approvalIntent = document.querySelector('#approvalIntent');
const approvalTarget = document.querySelector('#approvalTarget');
const approvalChanges = document.querySelector('#approvalChanges');
const approvalCommit = document.querySelector('#approvalCommit');
const approveVerifiedAction = document.querySelector('#approveVerifiedAction');
const rejectVerifiedAction = document.querySelector('#rejectVerifiedAction');
const verifiedApprovalStatus = document.querySelector('#verifiedApprovalStatus');
let browserControlPort = null;
let sensitiveReadRestricted = false;
let pendingVerifiedAction = null;

function ensureBrowserControlPort() {
  if (browserControlPort) return browserControlPort;
  browserControlPort = chrome.runtime.connect({ name: 'browser-control' });
  browserControlPort.onDisconnect.addListener(() => { browserControlPort = null; });
  return browserControlPort;
}

const openSidePanelBtn = document.querySelector('#openSidePanelBtn');
if (openSidePanelBtn) {
  openSidePanelBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (chrome.sidePanel?.open && tab?.id) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      }
    } catch (err) {
      console.error('Failed to open side panel:', err);
    }
  });
}

chrome.storage.local.get(['brokerUrl']).then((settings) => { brokerUrl.value = settings.brokerUrl || brokerUrl.defaultValue; });

function showCapture(capture, { stale = false, activeTab = null, unavailable = false } = {}) {
  const restricted = capture?.sensitiveReadRestricted === true || sensitiveReadRestricted;
  readApproval.hidden = !readMonitoring.checked;
  allowSensitiveRead.hidden = !(restricted && capture?.needsApproval);
  forgetSensitiveRead.hidden = !(restricted && capture?.sensitiveReadPersistent);
  sensitiveReadStatus.hidden = !(restricted && capture?.needsApproval);
  if (stale || unavailable) {
    pageTitle.textContent = `${activeTab?.title || 'Current page'} — cannot read`;
    return;
  }
  pageTitle.textContent = capture?.title || 'No page context yet';
}

async function refreshPairStatus() {
  const value = await chrome.runtime.sendMessage({ type: 'broker-status' });
  if (pairingCard) pairingCard.hidden = value.paired === true && setupCard?.hidden !== false;
  readMonitoring.checked = value.readMonitoringEnabled !== false;
  if (readEditableText) readEditableText.checked = value.readEditableText === true;
  readApproval.hidden = !readMonitoring.checked;
  sensitiveReadRestricted = value.sensitiveReadRestricted === true;
  restrictSensitiveRead.checked = sensitiveReadRestricted;
  pairStatus.textContent = value.configured ? (value.paired ? 'Browser paired: read-only watch stays connected in the background.' : 'Broker saved; pair only for first-time setup or recovery.') : 'Broker URL ready — click Save broker URL.';
  const polling = value.pollHeartbeat?.state;
  armStatus.textContent = value.controlEnabled
    ? (polling === 'websocket' ? 'browser control is ON. WebSocket command channel active.' : polling === 'active' ? 'browser control is ON. Command polling active.' : polling === 'failed' ? 'browser control is ON, but command polling could not start.' : 'browser control is ON. Starting command polling.')
    : 'browser control is OFF.';
  toggleBrowserControl.textContent = value.controlEnabled ? 'Turn browser control off' : 'Turn browser control on';
  browserIdentity.textContent = value.browserIdentity && typeof value.browserIdentity.name === 'string'
    ? `This browser: ${value.browserIdentity.name}${value.browserIdentity.isDefault ? ' (default)' : ''}`
    : 'This browser is not identified yet.';
  agentControlStatus.textContent = describeAgentControl(value.lastActingAgent);
  if (value.controlEnabled) ensureBrowserControlPort();
}

function renderVerifiedAction(transaction) {
  pendingVerifiedAction = transaction || null;
  verifiedApprovalCard.hidden = !transaction;
  approvalChanges.replaceChildren();
  if (!transaction) return;
  approvalIntent.textContent = transaction.proposal?.intent || 'Proposed browser change';
  approvalTarget.textContent = transaction.proposal?.target?.origin || 'Current approved page';
  if (transaction.proposal?.target?.kind === 'single_click') {
    approvalCommit.textContent = '';
    verifiedApprovalStatus.textContent = 'Waiting for your decision.';
    return;
  }
  const locatorText = (locator) => {
    if (locator?.targetText) return `visible text “${locator.targetText}”`;
    if (locator?.selector) return `selector ${locator.selector}`;
    if (locator?.ref) return `page reference ${locator.ref}`;
    return 'unspecified target';
  };
  const steps = transaction.proposal?.target?.operation?.steps || [];
  for (const change of transaction.proposal?.changes || []) {
    const step = steps.find((item) => item.field === change.field);
    const field = document.createElement('dt');
    field.textContent = step ? `${change.field} · ${step.control} · ${locatorText(step.locator)}` : change.field;
    const value = document.createElement('dd');
    value.textContent = change.to === null ? 'null' : String(change.to);
    approvalChanges.append(field, value);
  }
  approvalCommit.textContent = `Final action: ${locatorText(transaction.proposal?.target?.operation?.commit)}`;
  verifiedApprovalStatus.textContent = 'Waiting for your decision.';
}

async function refreshVerifiedActions() {
  const response = await chrome.runtime.sendMessage({ type: 'verified-actions-pending' });
  if (!response?.ok) { renderVerifiedAction(null); return; }
  renderVerifiedAction(response.pending?.[0] || null);
}

async function decidePendingVerifiedAction(decision) {
  if (!pendingVerifiedAction) return;
  approveVerifiedAction.disabled = true;
  rejectVerifiedAction.disabled = true;
  verifiedApprovalStatus.textContent = decision === 'approve' ? 'Binding approval to these exact changes…' : 'Rejecting proposal…';
  const response = await chrome.runtime.sendMessage({
    type: 'verified-action-decision',
    decision,
    transactionId: pendingVerifiedAction.proposal.transactionId,
    proposalHash: pendingVerifiedAction.proposalHash
  });
  verifiedApprovalStatus.textContent = response?.ok ? (decision === 'approve' ? 'Exact changes approved.' : 'Proposal rejected.') : (response?.error || 'Decision was not accepted.');
  approveVerifiedAction.disabled = false;
  rejectVerifiedAction.disabled = false;
  if (response?.ok) await refreshVerifiedActions();
}

async function refreshStatus() {
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['<all_urls>', 'http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) {
    enableReading.hidden = false;
    status.textContent = 'Enable reading normal tabs once so Field Browser Bridge can monitor work pages with read-only page context.';
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'capture-status' });
  showCapture(response.capture, response);
  status.textContent = response.capture ? (response.sensitiveReadRestricted ? 'Sensitive reads are restricted; Field Browser Bridge provides approved page context.' : 'Field Browser Bridge can read sensitive content by default.') : (response.error || 'Reading is ready when this browser is paired and monitoring is on.');
}

async function openContextReader() {
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['<all_urls>', 'http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) throw new Error('Normal-page permission is not enabled.');
  const response = await chrome.runtime.sendMessage({ type: 'context-ui-open' });
  if (response?.ok) {
    enableReading.hidden = true;
    showCapture(response.capture);
    status.textContent = response.capture?.sensitiveReadRestricted ? 'Sensitive reads are restricted; monitoring continues after this popup closes unless you turn it off.' : 'Field Browser Bridge can read sensitive content by default; monitoring continues after this popup closes unless you turn it off.';
  } else if (response?.needsApproval) {
    showCapture(response.capture);
    status.textContent = 'This protected workflow needs redacted-read approval before Field Browser Bridge can receive page text.';
  } else {
    showCapture(null, { unavailable: true, activeTab: response?.activeTab });
    status.textContent = response?.error || 'Cannot read this page.';
  }
}

saveBroker.addEventListener('click', async () => {
  const url = normalizeBrokerUrl(brokerUrl.value);
  if (url && !validateBrokerUrl(url)) {
    status.textContent = 'Enter an HTTPS server address, or HTTP on localhost.';
    return;
  }
  brokerUrl.value = url;
  const response = await chrome.runtime.sendMessage({ type: 'save-broker', brokerUrl: url });
  if (!response?.ok) {
    status.textContent = response?.error || 'Server address was not saved.';
    return;
  }
  status.textContent = response.pairingReset ? 'Server address saved. Pair this browser with the new server.' : 'Server address saved.';
  await refreshPairStatus();
});

pairBrowser.addEventListener('click', async () => {
  const url = normalizeBrokerUrl(brokerUrl.value);
  brokerUrl.value = url;
  const code = pairCode.value.trim().toUpperCase();
  pairCode.value = '';
  pairBrowser.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'pair-browser', brokerUrl: url, code });
  pairStatus.textContent = response.ok ? 'Browser paired. Read-only watch now reconnects in the background.' : `Pairing unavailable: ${response.error}`;
  pairBrowser.disabled = false;
});

resetPairing.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset-pairing' });
  pairStatus.textContent = 'Browser unpaired.';
  armStatus.textContent = 'browser control is OFF.';
  toggleBrowserControl.textContent = 'Turn browser control on';
});

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  status.textContent = 'Refreshing read-only page context…';
  const response = await chrome.runtime.sendMessage({ type: 'capture-active-tab' });
  if (response.ok) {
    showCapture(response.capture);
    status.textContent = response.sent ? 'Read-only context refreshed and delivered to Field Browser Bridge.' : 'Read-only context refreshed. Pair the browser to deliver it to Field Browser Bridge.';
  } else status.textContent = `Capture unavailable: ${response.error}`;
  captureButton.disabled = false;
});

toggleBrowserControl.addEventListener('click', async () => {
  toggleBrowserControl.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'toggle-browser-control' });
  if (response.ok) {
    armStatus.textContent = response.enabled ? 'browser control is ON. Starting command polling.' : 'browser control is OFF.';
    toggleBrowserControl.textContent = response.enabled ? 'Turn browser control off' : 'Turn browser control on';
    if (response.enabled) ensureBrowserControlPort();
  } else armStatus.textContent = `Control unchanged: ${response.error}`;
  toggleBrowserControl.disabled = false;
});

enableReading.addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['<all_urls>', 'http://*/*', 'https://*/*'] });
  if (!granted) { status.textContent = 'Reading normal tabs was not enabled. You can still refresh pages Edge allows.'; return; }
  await openContextReader();
});
allowSensitiveRead.addEventListener('click', async () => {
  allowSensitiveRead.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'approve-sensitive-read-origin' });
  if (response.ok) { showCapture(response.capture); status.textContent = 'Sensitive reads are allowed for this site while restriction is on.'; }
  else status.textContent = response.error || 'Could not allow sensitive reads for this site.';
  allowSensitiveRead.disabled = false;
});
restrictSensitiveRead.addEventListener('change', async () => {
  restrictSensitiveRead.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'set-sensitive-read-restricted', restricted: restrictSensitiveRead.checked });
  if (response.ok) {
    sensitiveReadRestricted = response.sensitiveReadRestricted === true;
    restrictSensitiveRead.checked = sensitiveReadRestricted;
    status.textContent = sensitiveReadRestricted ? 'Sensitive reads are restricted and require per-site approval.' : 'Field Browser Bridge can read sensitive content by default.';
    await openContextReader();
  } else {
    status.textContent = response.error || 'Could not update sensitive read restriction.';
    restrictSensitiveRead.checked = sensitiveReadRestricted;
  }
  restrictSensitiveRead.disabled = false;
});
readMonitoring.addEventListener('change', async () => {
  readMonitoring.disabled = true;
  readApproval.hidden = !readMonitoring.checked;
  const response = await chrome.runtime.sendMessage({ type: 'set-read-monitoring', enabled: readMonitoring.checked });
  if (response.ok) status.textContent = response.enabled ? 'Read monitoring is ON. Field Browser Bridge can read visible text on work pages.' : 'Read monitoring is OFF. You can still refresh a page manually.';
  else status.textContent = response.error || 'Could not update read monitoring.';
  readMonitoring.checked = response.enabled !== false;
  readApproval.hidden = !readMonitoring.checked;
  readMonitoring.disabled = false;
});
if (readEditableText) readEditableText.addEventListener('change', async () => {
  const requested = readEditableText.checked;
  readEditableText.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'set-read-editable-text', enabled: requested });
  if (response.ok) {
    readEditableText.checked = response.readEditableText === true;
    status.textContent = readEditableText.checked ? 'Text in documents and drafts can now be read.' : 'Text in documents and drafts is excluded.';
    await openContextReader();
  } else {
    readEditableText.checked = !requested;
    status.textContent = response.error || 'Could not update document reading.';
  }
  readEditableText.disabled = false;
});
forgetSensitiveRead.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'forget-sensitive-read-origin' });
  if (response.ok) { showCapture(response.capture); status.textContent = 'Sensitive read access removed for this site while restriction is on.'; }
  else status.textContent = response.error || 'Could not forget sensitive read access.';
});
approveVerifiedAction.addEventListener('click', () => decidePendingVerifiedAction('approve'));
rejectVerifiedAction.addEventListener('click', () => decidePendingVerifiedAction('reject'));

chrome.runtime.onMessage.addListener((event) => {
  if (event.type !== 'context-capture-updated') return false;
  if (event.reading) { pageTitle.textContent = 'Reading current page…'; status.textContent = 'Refreshing read-only page context…'; }
  else if (event.ok) { showCapture(event.capture); status.textContent = 'Read-only context is ready for Field Browser Bridge.'; }
  else { showCapture(null, { unavailable: true, activeTab: event.activeTab }); status.textContent = event.error || 'Cannot read this page.'; }
  return false;
});

openContextReader().catch(async () => {
  enableReading.hidden = false;
  status.textContent = 'Enable reading normal tabs once so Field Browser Bridge can use read-only page context.';
  await refreshStatus();
});
refreshPairStatus();
refreshVerifiedActions().catch(() => renderVerifiedAction(null));
window.setInterval(refreshPairStatus, 5_000);
window.setInterval(() => refreshVerifiedActions().catch(() => renderVerifiedAction(null)), 5_000);
window.addEventListener('unload', () => { chrome.runtime.sendMessage({ type: 'context-ui-closed' }).catch(() => {}); });
