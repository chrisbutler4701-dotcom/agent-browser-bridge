import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifiedActionEndpointUrl } from '../extension/broker-url.js';
import { executeVerifiedActionCommand } from '../extension/command-executor.js';
import { sha256 } from '../broker/src/verified-action.js';

test('verified action endpoints stay on the fixed broker route', () => {
  assert.equal(
    verifiedActionEndpointUrl('https://bridge.example.com/work-edge/ingest', 'pending'),
    'https://bridge.example.com/work-edge/verified-actions/pending'
  );
  assert.equal(verifiedActionEndpointUrl('https://example.com/ingest', 'pending'), 'https://example.com/work-edge/verified-actions/pending');
  assert.equal(verifiedActionEndpointUrl('http://127.0.0.1:8765/ingest', 'approve'), 'http://127.0.0.1:8765/work-edge/verified-actions/approve');
  assert.equal(verifiedActionEndpointUrl('http://127.0.0.1:8765/ingest', 'execute'), null);
});

test('popup renders approval values as text and delegates decisions to the service worker', () => {
  const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  assert.match(html, /id="verifiedApprovalCard"/);
  assert.match(html, /id="approvalCommit"/);
  assert.match(html, /Approve exact changes/);
  assert.match(popup, /value\.textContent/);
  assert.match(popup, /Final action:/);
  assert.match(popup, /step\.control/);
  assert.doesNotMatch(popup, /innerHTML/);
  assert.match(popup, /verified-action-decision/);
  assert.match(worker, /verifiedActionRequest/);
  assert.match(worker, /authorization: `Bearer \$\{settings\.brokerToken\}`/);
});

test('verified executor hashes private pre-state, rechecks it, commits, and returns only post-state', async () => {
  const originalDocument = globalThis.document;
  const input = {
    value: 'Unknown', isContentEditable: false,
    matches(selector) {
      if (selector.includes('password') || selector.includes('hidden')) return false;
      return selector === 'input,textarea,select,[contenteditable="true"]';
    },
    getAttribute() { return null; },
    dispatchEvent() { return true; },
  };
  let saved = false;
  const commit = {
    innerText: 'Submit assessment',
    matches(selector) { return selector === 'button,input[type="submit"],[role="button"]'; },
    getAttribute() { return null; },
    click() { saved = true; },
  };
  globalThis.document = {
    querySelector(selector) {
      if (selector === '[aria-label=Housing]') return input;
      if (selector === '#save') return commit;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const steps = [{ field: 'housingStatus', to: 'Currently housed', control: 'type', locator: { selector: '[aria-label=Housing]' } }];
  const beforeHash = sha256([{ field: 'housingStatus', value: 'Unknown' }]);
  try {
    const preflight = await executeVerifiedActionCommand({ type: 'verified_preflight', steps });
    assert.equal(preflight.result.currentBeforeHash, beforeHash);
    assert.equal(JSON.stringify(preflight).includes('Unknown'), false, 'private pre-action value must not leave the page executor');
    const applied = await executeVerifiedActionCommand({
      type: 'verified_apply', steps, commit: { selector: '#save' }, expectedBeforeHash: beforeHash,
      proposalHash: 'a'.repeat(64), approval: { proposalHash: 'a'.repeat(64) },
    });
    assert.equal(applied.ok, true);
    assert.equal(saved, true);
    assert.equal(applied.result.committed, true);
    const verified = await executeVerifiedActionCommand({
      type: 'verified_verify', steps,
      proposalHash: 'a'.repeat(64), approval: { proposalHash: 'a'.repeat(64) },
    });
    assert.deepEqual(verified.result.persistedChanges, [{ field: 'housingStatus', to: 'Currently housed' }]);
  } finally { globalThis.document = originalDocument; }
});
