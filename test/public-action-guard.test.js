import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCommand } from '../broker/src/command-queue.js';
import { executeBrowserCommand, executeVerifiedActionCommand } from '../extension/command-executor.js';

const allowed = [
  'Likely matches', '12 likes', 'Liked by Sara', 'Followers', 'Following',
  'Posted 2 days ago', 'Job posting', 'Apply filters', 'Apply filter', 'Shared with you',
  'Saved', 'Sender', 'Save Junior AI Engineer', 'Unsave X', 'Archive', 'Bookmark'
];
const blocked = [
  'Like Lizard Dance Party', 'Unlike', 'Follow', 'Unfollow', 'Share', 'Post',
  'Repost', 'Publish', 'Apply', 'Apply now', 'Easy Apply', 'Remove connection',
  'Delete', 'Pay now', 'Place order', 'Send', 'Submit', 'Upload', 'Confirm'
];

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pattern = (line) => {
  const literal = line.match(/= (\/.+\/i);$/)?.[1];
  assert.ok(literal, `expected a final-action regex in ${line}`);
  return new RegExp(literal.slice(1, -2), 'i');
};
const executorLines = source('../extension/command-executor.js').split('\n').filter((line) => line.includes('const finalAction ='));
const brokerLine = source('../broker/src/command-queue.js').split('\n').find((line) => line.includes('const FINAL_ACTION ='));

test('all three final-action lists classify public controls identically', () => {
  assert.equal(executorLines.length, 2);
  const lists = [...executorLines, brokerLine].map(pattern);
  assert.deepEqual(lists.map((list) => list.source), Array(3).fill(lists[0].source));
  for (const [index, list] of lists.entries()) {
    for (const label of allowed) assert.equal(list.test(label), false, `list ${index}: ${label}`);
    for (const label of blocked) assert.equal(list.test(label), true, `list ${index}: ${label}`);
  }
});

test('navigation classifies the URL path without treating a hostname as an action', () => {
  assert.equal(buildCommand('edge_open_tab', { url: 'https://send.example/inbox' }).command.finalAction, false);
  assert.equal(buildCommand('edge_open_tab', { url: 'https://shop.example/place-order' }).command.finalAction, true);
});

test('broker marks final actions and page executor refuses without approval', () => {
  const originalDocument = globalThis.document;
  let activations = 0;
  const button = {
    tagName: 'BUTTON', innerText: 'Like Lizard Dance Party',
    getAttribute() { return null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'button'); },
    dispatchEvent() { activations += 1; return true; },
    focus() {}
  };
  globalThis.document = {
    querySelector(selector) { return selector === 'button' ? button : null; },
    querySelectorAll(selector) { return selector === 'button' ? [button] : []; }
  };
  try {
    for (const label of blocked) assert.equal(buildCommand('edge_click', { targetText: label }).command.finalAction, true);
    for (const label of allowed) assert.equal(buildCommand('edge_click', { targetText: label }).command.finalAction, false);
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: 'button' } }).error, /final action/i);
    assert.match(executeBrowserCommand({ type: 'press', key: 'Enter', target: { selector: 'button' } }).error, /final action/i);
    assert.equal(activations, 0);
    const found = executeBrowserCommand({ type: 'find', selector: 'button' }).result.matches[0];
    assert.equal(found.unsafe, true);
    assert.equal(typeof found.ref, 'string');
  } finally { globalThis.document = originalDocument; }
});

test('an approved public-action commit uses the verified executor', async () => {
  const originalDocument = globalThis.document;
  let committed = 0;
  const field = {
    value: 'old',
    getAttribute() { return null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'input'); },
    dispatchEvent() { return true; }
  };
  const commit = {
    innerText: 'Like Lizard Dance Party',
    getAttribute() { return null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'button'); },
    click() { committed += 1; }
  };
  globalThis.document = { querySelector(selector) { return selector === 'input' ? field : selector === 'button' ? commit : null; } };
  try {
    const proposalHash = 'a'.repeat(64);
    const expectedBeforeHash = createHash('sha256').update(JSON.stringify([{ field: 'selection', value: 'old' }])).digest('hex');
    const result = await executeVerifiedActionCommand({
      type: 'verified_apply', proposalHash, approval: { proposalHash }, expectedBeforeHash,
      steps: [{ field: 'selection', to: 'liked', locator: { selector: 'input' } }],
      commit: { selector: 'button' }
    });
    assert.equal(result.ok, true);
    assert.equal(field.value, 'liked');
    assert.equal(committed, 1);
  } finally { globalThis.document = originalDocument; }
});

test('page executor rechecks the approved name and fingerprint before one final click', () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  let activations = 0;
  const button = { tagName: 'BUTTON', innerText: 'Send', getAttribute() { return null; },
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'button'); },
    dispatchEvent() { activations += 1; return true; }, focus() {} };
  globalThis.location = { href: 'https://example.test/inbox' };
  globalThis.document = { title: 'Inbox | Handshake', body: { innerText: 'Stable page' },
    querySelector(selector) { return selector === 'button' ? button : null; }, querySelectorAll() { return []; } };
  try {
    const inspected = executeBrowserCommand({ type: 'inspect_action', target: { selector: 'button' } });
    assert.equal(inspected.result.finalAction, true);
    const approvalBinding = inspected.result;
    assert.equal(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, approvalBinding }).ok, true);
    assert.ok(activations > 0);
    const before = activations;
    globalThis.document.title = '(3) Inbox';
    globalThis.document.body.innerText = '20 notifications';
    assert.equal(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, approvalBinding }).ok, true);
    globalThis.location.href = 'https://example.test/another-page';
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, approvalBinding }).error, /page changed/);
    globalThis.location.href = 'https://example.test/inbox';
    button.innerText = 'Delete';
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, approvalBinding }).error, /page changed/);
    assert.ok(activations > before);
    globalThis.document.querySelector = () => null;
    assert.match(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, approvalBinding }).error, /page changed/);
    globalThis.document.querySelector = (selector) => selector === 'button' ? button : null;
    assert.equal(executeBrowserCommand({ type: 'click', target: { selector: 'button' }, askBeforeFinalActions: false }).ok, true);
  } finally { globalThis.document = originalDocument; globalThis.location = originalLocation; }
});

test('inspection names the detail pane or card that owns Share', () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const heading = (text) => ({ innerText: text });
  const pane = { querySelector: () => heading('Technician, Audio') };
  const card = { querySelector: () => heading('Junior AI Engineer') };
  const control = (container, cardOwner) => ({ tagName: 'BUTTON', innerText: 'Share',
    getAttribute: () => null, setAttribute() {},
    matches: (selector) => selector.split(',').some((part) => part.trim() === 'button'),
    closest: (selector) => selector.includes('data-job-id') ? cardOwner : container });
  const paneShare = control(pane, null);
  const cardShare = control(card, card);
  globalThis.location = { href: 'https://example.test/jobs' };
  globalThis.document = { title: 'Jobs', body: { innerText: 'Jobs' },
    querySelector: (selector) => selector === '#pane-share' ? paneShare : selector === '#card-share' ? cardShare : null };
  try {
    assert.equal(executeBrowserCommand({ type: 'inspect_action', target: { selector: '#pane-share' } }).result.context, 'Technician, Audio');
    assert.equal(executeBrowserCommand({ type: 'inspect_action', target: { selector: '#card-share' } }).result.context, 'Junior AI Engineer');
  } finally { globalThis.document = originalDocument; globalThis.location = originalLocation; }
});

test('Share element without an action-control ancestor needs a binding and accepts the inspected binding', () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  let activations = 0;
  const element = { tagName: 'DIV', innerText: 'Share',
    getAttribute() { return null; }, matches() { return false; }, closest() { return null; },
    dispatchEvent() { activations += 1; return true; }, focus() {} };
  globalThis.location = { href: 'https://example.test/jobs' };
  globalThis.document = { title: 'Jobs', querySelector(selector) { return selector === '#share' ? element : null; } };
  try {
    const target = { selector: '#share' };
    const inspected = executeBrowserCommand({ type: 'inspect_action', target });
    assert.equal(inspected.result.finalAction, true);
    assert.equal(inspected.result.name, 'Share');
    const refused = executeBrowserCommand({ type: 'click', target });
    assert.match(refused.error, /Approval required/);
    assert.equal(activations, 0);
    const approved = executeBrowserCommand({ type: 'click', target, approvalBinding: inspected.result });
    assert.equal(approved.ok, true);
    assert.ok(activations > 0);
    const safe = { ...element, innerText: 'Open details' };
    globalThis.document.querySelector = (selector) => selector === '#share' ? safe : null;
    assert.equal(executeBrowserCommand({ type: 'click', target }).ok, true);
  } finally { globalThis.document = originalDocument; globalThis.location = originalLocation; }
});
