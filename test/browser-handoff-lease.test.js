import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHandoffLease } from '../broker/src/browser-handoff-lease.js';

const browserA = 'a'.repeat(64);
const browserB = 'b'.repeat(64);

test('claims are browser-bound, controller-owned, independent, and expire without replay', () => {
  let now = 1_000;
  const lease = new BrowserHandoffLease({ now: () => now, ttlMs: 100 });
  assert.equal(lease.status({ browserId: browserA, activeAgentIdentity: 'agent-a' }).claimed, false);
  const claimed = lease.claim({ browserId: browserA, controllerIdentity: 'human-a', activeAgentIdentity: 'agent-a' });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.controllerIdentity, 'human-a');
  assert.equal(claimed.activeAgentIdentity, 'agent-a');
  assert.equal(lease.status({ browserId: browserA, activeAgentIdentity: 'agent-b' }).activeAgentIdentity, 'agent-b');
  assert.throws(() => lease.assertAgentMayMutate(browserA), /human takeover active/i);
  assert.throws(() => lease.release({ browserId: browserA, controllerIdentity: 'human-b' }), /controller/i);
  assert.equal(lease.status({ browserId: browserB, activeAgentIdentity: 'agent-b' }).claimed, false);
  assert.doesNotThrow(() => lease.assertAgentMayMutate(browserB));
  assert.equal(lease.status({ browserId: browserA, activeAgentIdentity: 'agent-a' }).claimed, true);
  now += 101;
  assert.equal(lease.status({ browserId: browserA, activeAgentIdentity: 'agent-a' }).claimed, false);
  assert.doesNotThrow(() => lease.assertAgentMayMutate(browserA));
});

test('release only restores the exact active browser and controller', () => {
  const lease = new BrowserHandoffLease({ now: () => 1_000 });
  lease.claim({ browserId: browserA, controllerIdentity: 'human-a', activeAgentIdentity: 'agent-a' });
  assert.equal(lease.release({ browserId: browserA, controllerIdentity: 'human-a' }).claimed, false);
  assert.doesNotThrow(() => lease.assertAgentMayMutate(browserA));
});
