import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBrowserCommand } from '../extension/command-executor.js';

function fixture() {
  const previous = { document: globalThis.document, location: globalThis.location, InputEvent: globalThis.InputEvent };
  const nodes = [];
  const make = (tag, attrs = {}, parent = null) => {
    const node = { tagName: tag.toUpperCase(), attrs, parentElement: parent, children: [], events: [], clicks: 0,
      getAttribute(name) { return this.attrs[name] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; },
      matches(selector) { return selector.split(',').some((part) => {
        const piece = part.trim();
        if (piece.startsWith('[role=')) return this.attrs.role === piece.match(/\[role=["']?([^"'\]]+)/)?.[1];
        if (piece.startsWith('[contenteditable=')) return this.attrs.contenteditable === 'true';
        if (piece.startsWith('input')) {
          if (tag !== 'input') return false;
          const required = piece.match(/(?<!:not\()\[type="([^"]+)"\]/)?.[1];
          if (required && attrs.type !== required) return false;
          if (piece.includes(':not') && ['submit', 'button', 'checkbox', 'radio'].includes(attrs.type)) return false;
          return true;
        }
        if (piece.startsWith('button')) return tag === 'button';
        return piece === tag;
      }); },
      closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; },
      querySelectorAll(selector) { return nodes.filter((item) => item !== this && item.closest?.('form') === this && (selector.includes('button') ? item.tagName === 'BUTTON' : item.matches(selector))); },
      focus() { globalThis.document.activeElement = this; },
      dispatchEvent(event) { this.events.push(event); return true; },
      click() { this.clicks += 1; },
      getClientRects() { return [{}]; }
    };
    if (attrs.id) node.id = attrs.id;
    if (parent) parent.children.push(node);
    nodes.push(node);
    return node;
  };
  globalThis.document = { title: 'Test', activeElement: null, getElementById(id) { return nodes.find((node) => node.id === id); },
    querySelector(selector) { return nodes.find((node) => node.getAttribute('data-work-edge-ref') === selector.match(/data-work-edge-ref="([^"]+)"/)?.[1]) || null; },
    querySelectorAll(selector) { return nodes.filter((node) => selector === '[aria-controls]' && node.getAttribute('aria-controls') || node.matches(selector)); },
    getSelection() { return { selectAllChildren() {} }; } };
  globalThis.location = { href: 'https://example.test/jobs' };
  globalThis.InputEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  return { make, document: globalThis.document, restore() { Object.assign(globalThis, previous); } };
}

test('typing uses the native prototype setter and input event', () => {
  const dom = fixture();
  try {
    let assigned;
    const prototype = { set value(value) { assigned = value; } };
    const field = Object.assign(Object.create(prototype), dom.make('input', { placeholder: 'Job title', 'data-work-edge-ref': 'field' }));
    dom.document.querySelector = () => field;
    const result = executeBrowserCommand({ type: 'type', target: { ref: 'field' }, text: 'audio engineer' });
    assert.deepEqual(result, { ok: true, result: { typed: true, characters: 14, field: 'Job title' } });
    assert.equal(assigned, 'audio engineer');
    assert.deepEqual(field.events.map((event) => event.type), ['input', 'change']);
    assert.equal(field.events[0].inputType, 'insertText');
  } finally { dom.restore(); }
});

test('Enter submits a search form without approval', () => {
  const dom = fixture();
  try {
    const form = dom.make('form');
    const field = dom.make('input', { type: 'search' }, form);
    let submitted = 0;
    form.requestSubmit = () => { submitted += 1; };
    dom.document.activeElement = field;
    const result = executeBrowserCommand({ type: 'press', key: 'Enter' });
    assert.equal(result.result.submitted, 'form');
    assert.equal(submitted, 1);
  } finally { dom.restore(); }
});

test('Enter on a non-search Send form requires approval before key events', () => {
  const dom = fixture();
  try {
    const form = dom.make('form');
    const field = dom.make('input', {}, form);
    dom.make('button', { 'aria-label': 'Send' }, form);
    let submitted = 0;
    form.requestSubmit = () => { submitted += 1; };
    dom.document.activeElement = field;
    const inspected = executeBrowserCommand({ type: 'inspect_action', key: 'Enter' });
    assert.equal(inspected.result.finalAction, true);
    assert.equal(inspected.result.name, 'Send');
    const result = executeBrowserCommand({ type: 'press', key: 'Enter' });
    assert.match(result.error, /Approval required/);
    assert.equal(submitted, 0);
    assert.equal(field.events.length, 0);
  } finally { dom.restore(); }
});

test('an approved Enter submits the inspected non-search form once', () => {
  const dom = fixture();
  try {
    const form = dom.make('form');
    const field = dom.make('input', {}, form);
    const button = dom.make('button', { 'aria-label': 'Send' }, form);
    let submittedWith;
    form.requestSubmit = (submitter) => { submittedWith = submitter; };
    dom.document.activeElement = field;
    const inspected = executeBrowserCommand({ type: 'inspect_action', key: 'Enter' }).result;
    const result = executeBrowserCommand({ type: 'press', key: 'Enter', approvalBinding: inspected });
    assert.equal(result.result.submitted, 'form');
    assert.equal(submittedWith, button);
  } finally { dom.restore(); }
});

test('Enter in a textarea does not submit its containing form', () => {
  const dom = fixture();
  try {
    const form = dom.make('form');
    const field = dom.make('textarea', {}, form);
    let submitted = 0;
    form.requestSubmit = () => { submitted += 1; };
    dom.document.activeElement = field;
    assert.equal(executeBrowserCommand({ type: 'press', key: 'Enter' }).result.submitted, 'none');
    assert.equal(submitted, 0);
  } finally { dom.restore(); }
});

test('Enter clicks an adjacent Search button without a form', () => {
  const dom = fixture();
  try {
    const container = dom.make('div');
    const field = dom.make('input', {}, container);
    const button = dom.make('button', { 'aria-label': 'Search' }, container);
    container.querySelectorAll = () => [button];
    dom.document.activeElement = field;
    assert.equal(executeBrowserCommand({ type: 'press', key: 'Enter' }).result.submitted, 'button');
    assert.equal(button.clicks, 1);
  } finally { dom.restore(); }
});

test('Escape closes an open menu through its trigger', () => {
  const dom = fixture();
  try {
    const trigger = dom.make('button', { 'aria-controls': 'menu', 'aria-expanded': 'true' });
    const menu = dom.make('div', { role: 'menu', id: 'menu' });
    const item = dom.make('button', {}, menu);
    dom.document.activeElement = item;
    assert.equal(executeBrowserCommand({ type: 'press', key: 'Escape' }).result.closed, true);
    assert.equal(trigger.clicks, 1);
  } finally { dom.restore(); }
});

test('contenteditable uses insertText after selecting its contents', () => {
  const dom = fixture();
  try {
    const field = dom.make('div', { contenteditable: 'true', 'aria-label': 'Draft' });
    field.isContentEditable = true;
    let selected = false;
    dom.document.getSelection = () => ({ selectAllChildren(node) { selected = node === field; } });
    dom.document.execCommand = (name, _show, value) => { assert.equal(name, 'insertText'); field.textContent = value; return true; };
    dom.document.querySelector = () => field;
    assert.equal(executeBrowserCommand({ type: 'type', target: { ref: 'draft' }, text: 'hello' }).result.field, 'Draft');
    assert.equal(selected, true);
    assert.equal(field.textContent, 'hello');
  } finally { dom.restore(); }
});
