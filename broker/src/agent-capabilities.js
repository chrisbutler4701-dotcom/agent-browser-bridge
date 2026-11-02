export const AGENT_CAPABILITIES = Object.freeze([
  'browser.read',
  'browser.control',
  'browser.verified.propose',
  'browser.verified.execute',
  'browser.audit.read',
  'delegate_runs',
  'manage_browser_privacy',
  'private_browser_local',
]);

const ALL = new Set(AGENT_CAPABILITIES);
const REQUIREMENTS = Object.freeze({
  edge_status: ['browser.read'],
  edge_bridge_status: ['browser.read'],
  edge_list_browsers: ['browser.read'],
  edge_list_tabs: ['browser.read'],
  edge_active_tab: ['browser.read'],
  edge_snapshot: ['browser.read'],
  edge_screenshot: ['browser.read'],
  edge_extract_text: ['browser.read'],
  edge_find_elements: ['browser.read'],
  edge_list_open_tabs: ['browser.read'],
  edge_read_tab: ['browser.read'],
  edge_verified_action_inspect: ['browser.verified.propose'],
  edge_verified_action_propose: ['browser.verified.propose'],
  edge_verified_action_status: ['browser.verified.propose', 'browser.verified.execute', 'browser.audit.read'],
  edge_verified_action_execute: ['browser.verified.execute'],
  edge_verified_action_reconcile: ['browser.verified.execute'],
  edge_verified_receipt: ['browser.verified.propose', 'browser.verified.execute', 'browser.audit.read'],
  edge_click: ['browser.control'],
  edge_approval_wait: ['browser.control'],
  edge_press: ['browser.control'],
  edge_type: ['browser.control'],
  edge_scroll: ['browser.control'],
  edge_select: ['browser.control'],
  edge_navigate: ['browser.control'],
  edge_wait: ['browser.control'],
  edge_open_tab: ['browser.control'],
  edge_activate_tab: ['browser.control'],
  edge_close_tab: ['browser.control'],
});

export function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) throw new TypeError('capabilities must contain at least one grant');
  const normalized = [...new Set(capabilities.map((value) => {
    if (typeof value !== 'string' || !ALL.has(value.trim())) throw new TypeError(`unknown agent capability: ${value}`);
    return value.trim();
  }))].sort();
  return normalized;
}

export function hasCapability(principal, capability) {
  return principal?.capabilities?.includes('*') || principal?.capabilities?.includes(capability) || false;
}

export function canUseTool(principal, tool, args = {}) {
  const required = tool === 'edge_find_elements' && args?.scope === 'live'
    ? ['browser.control']
    : REQUIREMENTS[tool];
  return Array.isArray(required) && required.some((capability) => hasCapability(principal, capability));
}

export function visibleTools(tools, principal) {
  return tools.filter((tool) => canUseTool(principal, tool.name)
    || (tool.name === 'edge_find_elements' && hasCapability(principal, 'browser.control')));
}
