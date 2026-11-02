import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBrowserCommand } from '../extension/command-executor.js';
import { buildCommand } from '../broker/src/command-queue.js';
import { isOlderExtension, MINIMUM_EXTENSION_VERSION } from '../broker/src/extension-minimums.js';

function page(cards) {
  const previous = { document: globalThis.document, location: globalThis.location };
  const all = [];
  let clicks = 0;
  const make = (tag, text, parent = null) => {
    const attrs = new Map();
    const element = { tagName: tag.toUpperCase(), innerText: text, textContent: text, parentElement: parent, children: [],
      getAttribute: (key) => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value),
      matches: (selector) => selector.split(',').some((piece) => piece.trim() === tag),
      closest: () => null, focus() {}, dispatchEvent(type) { if (type?.type === 'click') clicks += 1; return true; },
      querySelector: () => null };
    parent?.children.push(element);
    all.push(element);
    return element;
  };
  for (const card of cards) {
    const container = make('article', card.title);
    make('h2', card.title, container);
    make('button', card.button, container);
  }
  globalThis.location = { href: 'https://example.test/jobs' };
  globalThis.document = { title: 'Jobs', querySelectorAll(selector) {
    if (selector === '*') return all;
    if (selector.includes('[role="row"]')) return all.filter((item) => item.tagName === 'TR');
    return all.filter((item) => ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(item.tagName));
  }, querySelector(selector) {
    const ref = selector.match(/^\[data-work-edge-ref="(.+)"\]$/)?.[1];
    return ref ? all.find((item) => item.getAttribute('data-work-edge-ref') === ref) || null : null;
  } };
  return { make, all, clicks: () => clicks, restore() { globalThis.document = previous.document; globalThis.location = previous.location; } };
}

test('exact names beat contains; near selects the deepest shared card', () => {
  const dom = page([{ title: 'Senior AI Engineer', button: 'Share page' }, { title: 'Junior AI Engineer', button: 'Share' }, { title: 'Other', button: 'Share' }]);
  try {
    const result = executeBrowserCommand({ type: 'click', target: { targetText: 'Share', near: 'Junior AI Engineer' }, askBeforeFinalActions: false });
    assert.equal(result.ok, true);
    assert.equal(dom.clicks(), 1);
    const inspected = executeBrowserCommand({ type: 'inspect_action', target: { targetText: 'Share', near: 'Junior AI Engineer' } });
    assert.equal(inspected.result.name, 'Share');
    assert.ok(inspected.result.ref);
  } finally { dom.restore(); }
});

test('repeated final-action names are ambiguous and never click', () => {
  const dom = page([1, 2, 3].map((n) => ({ title: `Job ${n}`, button: 'Share' })));
  try {
    const result = executeBrowserCommand({ type: 'click', target: { targetText: 'Share' } });
    assert.equal(result.code, 'ambiguous_target');
    assert.equal(result.candidates.length, 3);
    assert.equal(dom.clicks(), 0);
  } finally { dom.restore(); }
});

test('legacy Gmail row text still opens a non-final row', () => {
  const dom = page([]);
  dom.make('tr', 'Inbox subject from Alice');
  try {
    assert.equal(executeBrowserCommand({ type: 'click', target: { targetText: 'Inbox subject' } }).ok, true);
    assert.equal(dom.clicks(), 1);
  } finally { dom.restore(); }
});

test('near stays in the command target and requires extension 1.4.9', () => {
  assert.deepEqual(buildCommand('edge_click', { targetText: 'Share', near: 'Junior AI Engineer' }).command.target,
    { targetText: 'Share', near: 'Junior AI Engineer' });
  assert.equal(MINIMUM_EXTENSION_VERSION, '1.4.9');
  assert.equal(isOlderExtension('1.4.8', MINIMUM_EXTENSION_VERSION), true);
  assert.equal(isOlderExtension('1.4.9', MINIMUM_EXTENSION_VERSION), false);
  assert.equal(isOlderExtension(null, MINIMUM_EXTENSION_VERSION), false);
});

test('pre-rendered menu hidden by an ancestor opens with stable item refs', () => {
  const previous = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  const attrs = (values = {}) => new Map(Object.entries(values));
  const node = (tag, name, values = {}, parentElement = null) => {
    const data = attrs(values);
    return { tagName: tag.toUpperCase(), innerText: name, textContent: name, parentElement, hidden: false,
      getAttribute: (key) => data.get(key) ?? null, setAttribute: (key, value) => data.set(key, value),
      matches: (selector) => selector.split(',').some((part) => part.trim() === tag || part.includes(`[role="${data.get('role')}"]`)),
      getClientRects: () => [{}], focus() {}, dispatchEvent(event) { if (event.type === 'click') container.display = 'block'; return true; },
      querySelectorAll: () => [] };
  };
  const container = node('div', '', { role: 'menu', id: 'actions' });
  container.display = 'none';
  const item = node('button', 'Open details', { role: 'menuitem' }, container);
  container.querySelectorAll = () => [item];
  const trigger = node('button', 'More actions', { 'aria-haspopup': 'menu', 'aria-controls': 'actions' });
  const all = [trigger, container, item];
  globalThis.document = { title: 'Jobs', getElementById: (id) => id === 'actions' ? container : null,
    querySelectorAll: (selector) => selector === '[role="menu"],[role="listbox"],[role="dialog"]' ? [container] : selector === 'button' ? [trigger, item] : all,
    querySelector: (selector) => all.find((element) => selector.includes(element.getAttribute('data-work-edge-ref'))) || trigger };
  globalThis.location = { href: 'https://example.test/jobs' };
  globalThis.getComputedStyle = (element) => ({ display: element.display || 'block', visibility: 'visible' });
  try {
    assert.equal(executeBrowserCommand({ type: 'find', selector: 'button' }).result.matches.length, 1);
    const clicked = executeBrowserCommand({ type: 'click', target: { targetText: 'More actions' } });
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(clicked.result.opened.role, 'menu');
    assert.deepEqual(clicked.result.opened.items.map(({ name }) => name), ['Open details']);
    assert.ok(clicked.result.opened.items[0].ref);
    assert.equal(executeBrowserCommand({ type: 'find', selector: 'button' }).result.matches.length, 2);
  } finally { Object.assign(globalThis, previous); }
});
