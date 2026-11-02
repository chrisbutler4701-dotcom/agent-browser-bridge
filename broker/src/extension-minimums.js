// Minimums follow the extension feature commits, not the broker release.
export const TOOL_MINIMUMS = Object.freeze({
  edge_list_open_tabs: '1.1.0', edge_open_tab: '1.1.0', edge_activate_tab: '1.1.0', edge_close_tab: '1.1.0', edge_read_tab: '1.1.0'
});
export const COMMAND_MINIMUMS = Object.freeze({ list_tabs: '1.1.0', open_tab: '1.1.0', activate_tab: '1.1.0', close_tab: '1.1.0', read_tab: '1.1.0', inspect_action: '1.4.6' });
export const PER_TAB_READ_MINIMUM = '1.2.0';
export const FRAME_TARGET_MINIMUM = '1.4.0';
export const APPROVAL_MINIMUM = '1.4.6';
export const LOCATOR_MINIMUMS = Object.freeze({ near: '1.4.9' });
export const ROWS_MINIMUM = '1.4.18';
export const MINIMUM_EXTENSION_VERSION = '1.4.9';

export function isOlderExtension(have, need) {
  if (!/^\d+\.\d+\.\d+$/.test(have || '')) return false;
  const left = have.split('.').map(Number);
  const right = need.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

export function outdatedExtension(browser, have, tool, need) {
  return { ok: false, code: 'extension_outdated', error: `This browser ("${browser.name}") runs extension ${have}; ${tool} needs ${need} or newer. Update it from Cockpit browser settings (the Update button).` };
}
