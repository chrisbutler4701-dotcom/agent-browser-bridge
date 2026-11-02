import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBrowserCommand } from '../extension/command-executor.js';

test('live discovery creates refs for safe fields without exposing form text or sensitive fields', () => {
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  const refs = new Map();
  const field = (tagName, attrs, value) => ({
    tagName, attrs, value, textContent: value,
    getAttribute(name) { return this.attrs[name] ?? null; },
    matches(selector) { return selector.split(',').some((part) => part.trim().startsWith(tagName.toLowerCase()) && (!part.includes('[type=') || part.includes(`"${attrs.type}"`))); },
    closest() { return null; },
    setAttribute(name, ref) { if (name === 'data-work-edge-ref') refs.set(ref, this); },
    focus() {}, dispatchEvent() { return true; }
  });
  const safe = field('INPUT', { name: 'search' }, 'private draft');
  const password = field('INPUT', { type: 'password', name: 'password' }, 'secret');
  globalThis.document = {
    querySelectorAll(selector) { return selector === 'input' ? [safe, password] : []; },
    querySelector(selector) { return refs.get(selector.match(/data-work-edge-ref="([^"]+)"/)?.[1]) || null; }
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const found = executeBrowserCommand({ type: 'find', selector: 'input' });
    assert.equal(found.ok, true);
    assert.equal(found.result.matches.length, 1);
    assert.deepEqual(Object.keys(found.result.matches[0]).sort(), ['ref', 'tag', 'text']);
    assert.equal(found.result.matches[0].text, '');
    assert.equal(refs.size, 1);
    assert.deepEqual(executeBrowserCommand({ type: 'type', target: { ref: found.result.matches[0].ref }, text: 'new search' }), { ok: true, result: { typed: true, characters: 10, field: '' } });
    assert.equal(safe.value, 'new search');
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalStyle;
  }
});

test('live button names use accessible fallbacks and expose final-action refs for approval', () => {
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  const refs = new Map();
  const named = (attrs = {}, innerText = '', children = []) => ({
    tagName: 'BUTTON', attrs, innerText, children, clicks: 0,
    getAttribute(name) { return this.attrs[name] ?? null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'button'); },
    querySelectorAll() { return this.children; },
    setAttribute(name, value) { if (name === 'data-work-edge-ref') refs.set(value, this); },
    dispatchEvent(event) { if (event.type === 'click') this.clicks += 1; return true; },
    focus() {}
  });
  const child = (tagName, attrs = {}, textContent = '') => ({
    tagName, textContent,
    getAttribute(name) { return attrs[name] ?? null; },
    matches(selector) { return selector === 'img[alt]' ? tagName === 'IMG' : selector === 'svg title' ? tagName === 'TITLE' : selector === '[aria-label]' && attrs['aria-label'] !== undefined; }
  });
  const buttons = [
    named({ 'aria-label': 'Open profile options' }),
    named({ 'aria-labelledby': 'first second' }),
    named({ title: 'Open menu' }),
    named({}, '', [child('IMG', { alt: 'Alex Example' })]),
    named({}, '', [child('TITLE', {}, 'Settings')]),
    named({}, '', [child('SPAN', { 'aria-label': 'Account options' })]),
    named({ 'aria-label': 'Other name' }, 'Visible  name'),
    named({ 'aria-label': 'Submit your project' })
  ];
  const labels = { first: { textContent: 'Profile' }, second: { textContent: 'options' } };
  globalThis.document = {
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; },
    getElementById(id) { return labels[id] || null; },
    querySelector(selector) { return refs.get(selector.match(/data-work-edge-ref="([^"]+)"/)?.[1]) || null; }
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const found = executeBrowserCommand({ type: 'find', selector: 'button' });
    assert.equal(found.ok, true);
    assert.deepEqual(found.result.matches.map((match) => match.text), [
      'Open profile options', 'Profile options', 'Open menu', 'Alex Example', 'Settings', 'Account options', 'Visible name', 'Submit your project'
    ]);
    assert.equal(found.result.matches[7].unsafe, true);
    assert.equal(typeof found.result.matches[7].ref, 'string');
    assert.equal(refs.size, 8);
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { ref: found.result.matches[0].ref } }), { ok: true, result: { clicked: true } });
    assert.equal(buttons[0].clicks, 1);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalStyle;
  }
});

test('live discovery puts open menu controls first, then viewport controls, and caps at 60', () => {
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  const originalWindow = globalThis.window;
  const make = (text, left, overlay = null) => ({
    tagName: 'A', innerText: text,
    getAttribute() { return null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'a'); },
    closest() { return overlay; },
    getBoundingClientRect() { return { left, right: left + 20, top: 10, bottom: 30 }; },
    setAttribute() {},
  });
  const menu = { getAttribute() { return null; } };
  const links = Array.from({ length: 65 }, (_, index) => make(`Link ${index}`, index < 40 ? 2000 : 20));
  links.push(make('Profile', 2000, menu), make('Visible last', 20));
  globalThis.document = { querySelectorAll(selector) { return selector === 'a' ? links : selector === '[role=menuitem]' ? [links.at(-2)] : []; } };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.window = { innerWidth: 1000, innerHeight: 700 };
  try {
    const found = executeBrowserCommand({ type: 'find', selector: 'a' });
    assert.equal(found.ok, true);
    assert.equal(found.result.matches.length, 60);
    assert.equal(found.result.matches[0].text, 'Profile');
    assert.equal(found.result.matches[1].text, 'Link 40');
    assert.equal(found.result.matches[26].text, 'Visible last');
    assert.equal(found.result.matches[27].text, 'Link 0');
    assert.equal(executeBrowserCommand({ type: 'find', selector: '[role=menuitem]' }).result.matches[0].text, 'Profile');
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalStyle;
    globalThis.window = originalWindow;
  }
});

test('live discovery reuses resolvable refs, including controls requiring approval', () => {
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  const refs = new Map();
  const make = (text) => ({
    tagName: 'A', innerText: text, attrs: {}, clicks: 0,
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; refs.set(value, this); },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'a'); },
    closest() { return null; },
    dispatchEvent(event) { if (event.type === 'click') this.clicks += 1; return true; },
    focus() {},
  });
  const menuItem = make('Open menu');
  const otherLink = make('Open help');
  const unsafe = make('Submit changes');
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === 'a') return [menuItem, otherLink, unsafe];
      if (selector === '[role=menuitem]') return [menuItem, unsafe];
      return [];
    },
    querySelector(selector) { return refs.get(selector.match(/data-work-edge-ref="([^"]+)"/)?.[1]) || null; },
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const first = executeBrowserCommand({ type: 'find', selector: 'a' }).result.matches;
    assert.ok(first[0].ref);
    assert.ok(first[1].ref);
    assert.notEqual(first[0].ref, first[1].ref);
    assert.equal(first[2].unsafe, true);
    assert.ok(first[2].ref);
    const second = executeBrowserCommand({ type: 'find', selector: '[role=menuitem]' }).result.matches;
    assert.equal(second[0].ref, first[0].ref);
    assert.equal(second[1].ref, first[2].ref);
    assert.equal(refs.size, 3);
    assert.deepEqual(executeBrowserCommand({ type: 'click', target: { ref: first[0].ref } }), { ok: true, result: { clicked: true } });
    assert.equal(menuItem.clicks, 1);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalStyle;
  }
});
