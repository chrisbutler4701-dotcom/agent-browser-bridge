const BROWSER_ID_PROPERTY = { browserId: { type: 'string', pattern: '^brw_[a-f0-9]{16}$' } };
const withBrowserId = (input) => ({ ...input, properties: { ...input.properties, ...BROWSER_ID_PROPERTY } });
// Tab targeting (approved in 2026-10-22). Omit tabId to use the front tab.
const TAB_ID_PROPERTY = { tabId: { type: 'integer', minimum: 0, maximum: 2147483647, description: 'Tab id from edge_list_open_tabs. Omit to act on the front tab. Background tabs are worked without bringing them to the front.' } };
const TAB_TARGETABLE = new Set(['edge_snapshot', 'edge_extract_text', 'edge_click', 'edge_press', 'edge_type', 'edge_scroll', 'edge_select', 'edge_navigate', 'edge_wait', 'edge_screenshot', 'edge_find_elements']);
const withTabId = (name, input) => (TAB_TARGETABLE.has(name) ? { ...input, properties: { ...input.properties, ...TAB_ID_PROPERTY } } : input);
const TAB_REQUIRED_INPUT = { type: 'object', properties: { ...TAB_ID_PROPERTY }, required: ['tabId'], additionalProperties: false };
const READ_TAB_INPUT = { type: 'object', properties: { ...TAB_ID_PROPERTY, maxCharacters: { type: 'integer', minimum: 1, maximum: 200000 } }, required: ['tabId'], additionalProperties: false };
const ACTOR_LABEL = { actorLabel: { type: 'string', maxLength: 60 } };
const OPEN_TAB_INPUT = { type: 'object', properties: { url: { type: 'string', maxLength: 2000 }, active: { type: 'boolean', description: 'Bring the new tab to the front. Defaults to false so your current tab is not disturbed.' }, ...ACTOR_LABEL }, additionalProperties: false };
const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const TEXT_INPUT = { type: 'object', properties: { maxCharacters: { type: 'integer', minimum: 1, maximum: 200000 } }, additionalProperties: false };
const FIND_INPUT = { type: 'object', properties: { selector: { type: 'string', maxLength: 256 }, scope: { type: 'string', enum: ['capture', 'live'] } }, required: ['selector'], additionalProperties: false };

// Selector, targetText, and ref are alternative ways to locate the same
// element; `text` (on edge_type only) is the content to insert, never a
// locator, so the two concepts can never collide in a single call.
const TARGET_PROPERTIES = {
  selector: { type: 'string', maxLength: 512 },
  targetText: { type: 'string', maxLength: 200 },
  near: { type: 'string', maxLength: 200, description: 'Nearby words that identify one control among repeated names, such as a job title.' },
  ref: { type: 'string', maxLength: 200 }
};
const VERIFIED_LOCATOR = {
  type: 'object',
  properties: TARGET_PROPERTIES,
  oneOf: [{ required: ['selector'] }, { required: ['targetText'] }, { required: ['ref'] }],
  additionalProperties: false
};
const TIMEOUT_PROPERTY = { timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } };
const CLICK_INPUT = { type: 'object', properties: { ...TARGET_PROPERTIES, ...ACTOR_LABEL, approved: { type: 'boolean' }, ...TIMEOUT_PROPERTY }, additionalProperties: false };
const PRESS_INPUT = { type: 'object', properties: { ...TARGET_PROPERTIES, ...ACTOR_LABEL, key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace'] }, approved: { type: 'boolean' }, ...TIMEOUT_PROPERTY }, required: ['key'], additionalProperties: false };
const TYPE_INPUT = { type: 'object', properties: { ...TARGET_PROPERTIES, text: { type: 'string', maxLength: 4000 }, approved: { type: 'boolean' }, ...TIMEOUT_PROPERTY }, required: ['text'], additionalProperties: false };
const SCROLL_INPUT = { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', minimum: 1, maximum: 20000 }, ...TIMEOUT_PROPERTY }, additionalProperties: false };
const SELECT_INPUT = { type: 'object', properties: { ...TARGET_PROPERTIES, value: { type: 'string', maxLength: 500 }, optionText: { type: 'string', maxLength: 200 }, approved: { type: 'boolean' }, ...TIMEOUT_PROPERTY }, additionalProperties: false };
const NAVIGATE_INPUT = { type: 'object', properties: { url: { type: 'string', maxLength: 2000 }, ...ACTOR_LABEL, approved: { type: 'boolean' }, ...TIMEOUT_PROPERTY }, required: ['url'], additionalProperties: false };
const WAIT_INPUT = { type: 'object', properties: { ms: { type: 'integer', minimum: 1, maximum: 30000 }, ...TIMEOUT_PROPERTY }, required: ['ms'], additionalProperties: false };
const APPROVAL_WAIT_INPUT = { type: 'object', properties: { approvalId: { type: 'string', minLength: 1, maxLength: 200 }, waitMs: { type: 'integer', minimum: 0, maximum: 50000 } }, required: ['approvalId'], additionalProperties: false };
const VERIFIED_CHANGE = {
  type: 'object',
  properties: {
    field: { type: 'string', minLength: 1, maxLength: 200 },
    to: { type: 'string', maxLength: 4000 },
    control: { type: 'string', enum: ['type', 'select'] },
    locator: VERIFIED_LOCATOR
  },
  required: ['field', 'to', 'control', 'locator'],
  additionalProperties: false
};
const VERIFIED_COMMIT = VERIFIED_LOCATOR;
const VERIFIED_INSPECT_INPUT = {
  type: 'object',
  properties: {
    changes: { type: 'array', minItems: 1, maxItems: 100, items: VERIFIED_CHANGE },
    commit: VERIFIED_COMMIT,
    ...TIMEOUT_PROPERTY
  },
  required: ['changes', 'commit'],
  additionalProperties: false
};
const VERIFIED_PROPOSE_INPUT = {
  type: 'object',
  properties: {
    intent: { type: 'string', minLength: 1, maxLength: 500 },
    inspectionId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
    recordIdHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }
  },
  required: ['intent', 'inspectionId'],
  additionalProperties: false
};
const VERIFIED_EXECUTE_INPUT = {
  type: 'object',
  properties: { transactionId: { type: 'string', minLength: 1, maxLength: 200 }, ...TIMEOUT_PROPERTY },
  required: ['transactionId'],
  additionalProperties: false
};
const VERIFIED_STATUS_INPUT = {
  type: 'object',
  properties: { transactionId: { type: 'string', minLength: 1, maxLength: 200 } },
  required: ['transactionId'],
  additionalProperties: false
};
const SCREENSHOT_INPUT = { type: 'object', properties: { ...TIMEOUT_PROPERTY }, additionalProperties: false };
const toolTitle = (name) => name.replace(/^edge_/, '').split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');

export const READ_ONLY_TOOLS = [
  ['edge_status', 'Return connector and capture availability.', EMPTY_INPUT],
  ['edge_bridge_status', 'Return the active Work Browser Bridge transport state: latest capture availability, recent outbound command polling, and control safety boundaries. This does not expose browser secrets.', EMPTY_INPUT],
  ['edge_list_browsers', 'List paired browsers by opaque public id, including online, control, and default status.', EMPTY_INPUT],
  ['edge_list_tabs', 'List every open tab in the paired browser (tab id, title, address, which is in front); same as edge_list_open_tabs. Falls back to captured tabs when the browser cannot list them.', EMPTY_INPUT],
  ['edge_active_tab', 'Return metadata for the most recently captured active tab.', EMPTY_INPUT],
  ['edge_snapshot', 'Return the latest policy-filtered DOM snapshot.', EMPTY_INPUT],
  ['edge_screenshot', 'Capture and return a fresh raw-screen PNG from the paired browser. This read-only tool requires the browser control toggle, a screenshot-enabled broker policy, and extension 0.3.0 or newer. The image can include visible overlays.', SCREENSHOT_INPUT],
  ['edge_extract_text', 'Extract bounded text from the latest captured page.', TEXT_INPUT],
  ['edge_verified_action_status', 'Return the phase and approval-safe metadata for one verified-action transaction.', VERIFIED_STATUS_INPUT],
  ['edge_verified_receipt', 'Return one durable verified-action receipt and its chain-validation status.', VERIFIED_STATUS_INPUT],
  ['edge_list_open_tabs', 'List every open tab in the paired browser: tab id, window, title, address, and which tab is in front. Use these ids with tabId on other tools.', EMPTY_INPUT],
  ['edge_read_tab', 'Read the text and page summary of any open tab by tabId, including background tabs, without switching to it.', READ_TAB_INPUT],
  ['edge_find_elements', 'Find simple selectors. scope "capture" (default) uses the latest sanitized capture; scope "live" queries only visible, non-form elements in the active approved tab through the enabled browser-control transport and returns bounded click refs for safe results.', FIND_INPUT]
].map(([name, description, inputSchema]) => ({
  name,
  description,
  inputSchema: withBrowserId(withTabId(name, inputSchema)),
  annotations: { title: toolTitle(name), readOnlyHint: true, destructiveHint: false, approvalRequired: false }
}));

// Implemented via the durable browser command queue: each call enqueues a
// command for the currently paired browser and waits for its result. Ordinary
// commands refuse password/hidden/MFA-like fields. A final control requires
// owner approval and a fresh binding check before the broker dispatches it.
// The control toggle alone never authorizes it.
export const ACTION_TOOLS = [
  ['edge_verified_action_inspect', 'Inspect an exact proposed field change and commit target. Current values are hashed inside the paired browser and never returned. Use the short-lived inspectionId to create a proposal.', VERIFIED_INSPECT_INPUT, false, false],
  ['edge_verified_action_propose', 'Create an immutable, browser-bound proposal from one short-lived verified inspection. This never executes the change; the paired browser must show and approve the exact proposal.', VERIFIED_PROPOSE_INPUT, false, false],
  ['edge_verified_action_execute', 'Execute one browser-approved transaction, re-check pre-action state, commit it, verify the resulting field values, and return a receipt.', VERIFIED_EXECUTE_INPUT, true, true],
  ['edge_verified_action_reconcile', 'Read back the fields of an indeterminate verified action without replaying it, then record whether the approved values persisted.', VERIFIED_EXECUTE_INPUT, false, false],
  ['edge_click', 'Click by ref, selector, or targetText. Use near with targetText when names repeat. Ordinary controls run immediately. Final actions ask the owner first and return approval_pending; call edge_approval_wait, never retry the click yourself.', CLICK_INPUT, false, false],
  ['edge_press', 'Press by ref, selector, or targetText. Use near with targetText when names repeat. Final actions ask the owner first; call edge_approval_wait, never retry the press yourself.', PRESS_INPUT, false, false],
  ['edge_type', 'Focus an ordinary writable field by ref, selector, or targetText; use near when names repeat. text is the value to insert. Never reads the existing value; sensitive and final controls remain blocked.', TYPE_INPUT, false, false],
  ['edge_scroll', 'Scroll the active tab viewport in a direction by an amount. This is a control operation and requires the browser control toggle to be ON.', SCROLL_INPUT, false, false],
  ['edge_select', 'Choose an option in an ordinary <select> element located by selector, targetText, or ref. Sensitive and final controls remain blocked.', SELECT_INPUT, false, false],
  ['edge_navigate', 'Ordinary controls run immediately. Final actions (send, submit, apply, post, share, like, follow, delete, buy, pay, sign, confirm, upload) ask the owner first when the browser requires it: you get code approval_pending with an approvalId — then call edge_approval_wait until it returns approved, declined, expired or failed. Never retry the navigation yourself.', NAVIGATE_INPUT, false, false],
  ['edge_approval_wait', 'Wait for the outcome of an approval you requested. Use the approvalId from approval_pending; do not retry the action.', APPROVAL_WAIT_INPUT, false, false],
  ['edge_open_tab', 'Open a new tab, in the background by default, optionally at a policy-allowed URL. Returns the new tab id.', OPEN_TAB_INPUT, false, false],
  ['edge_activate_tab', 'Bring a tab to the front by tabId. Only use this when the user asks to see the tab; every other tool can work a background tab without switching.', TAB_REQUIRED_INPUT, false, false],
  ['edge_close_tab', 'Close a tab by tabId.', TAB_REQUIRED_INPUT, true, false],
  ['edge_wait', 'Ask the browser to wait for a bounded number of milliseconds and confirm it is still responsive. This is a control operation and requires the browser control toggle to be ON.', WAIT_INPUT, false, false]
].map(([name, description, inputSchema, destructiveHint, approvalRequired]) => ({
  name,
  description,
  inputSchema: withBrowserId(withTabId(name, inputSchema)),
  annotations: { title: toolTitle(name), readOnlyHint: false, destructiveHint, approvalRequired }
}));

export const ALL_TOOLS = [...READ_ONLY_TOOLS, ...ACTION_TOOLS];
