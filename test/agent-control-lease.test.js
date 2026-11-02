import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentControlLease, idleMsFromEnv } from '../broker/src/agent-control-lease.js';

const browserA = 'a'.repeat(64);
const browserB = 'b'.repeat(64);

test('first agent gets control; a second agent is told to wait', () => {
  let now = 1_000;
  const lease = new AgentControlLease({ now: () => now, idleMs: 100 });
  const first = lease.acquire({ browserId: browserA, agentId: 'claude-code' });
  assert.equal(first.granted, true);
  assert.equal(first.holder, 'claude-code');
  now += 40;
  const second = lease.acquire({ browserId: browserA, agentId: 'codex' });
  assert.equal(second.granted, false);
  assert.equal(second.holder, 'claude-code');
  assert.equal(second.retryAfterMs, 60);
});

test('renews for the holder', () => {
  let now = 1_000;
  const lease = new AgentControlLease({ now: () => now, idleMs: 100 });
  lease.acquire({ browserId: browserA, agentId: 'claude-code' });
  now += 90;
  assert.equal(lease.acquire({ browserId: browserA, agentId: 'claude-code' }).granted, true);
  now += 90;
  assert.equal(lease.acquire({ browserId: browserA, agentId: 'codex' }).granted, false);
});

test('expires after idle', () => {
  let now = 1_000;
  const lease = new AgentControlLease({ now: () => now, idleMs: 100 });
  lease.acquire({ browserId: browserA, agentId: 'claude-code' });
  now += 101;
  assert.deepEqual(lease.status({ browserId: browserA }), { holder: null, expiresAt: null });
  assert.equal(lease.acquire({ browserId: browserA, agentId: 'codex' }).granted, true);
});

test('locks are independent per browser', () => {
  const lease = new AgentControlLease({ now: () => 1_000, idleMs: 100 });
  assert.equal(lease.acquire({ browserId: browserA, agentId: 'claude-code' }).granted, true);
  assert.equal(lease.acquire({ browserId: browserB, agentId: 'codex' }).granted, true);
  assert.equal(lease.acquire({ browserId: browserA, agentId: 'codex' }).granted, false);
  assert.equal(lease.status({ browserId: browserB }).holder, 'codex');
});

test('rejects missing identities and reads idle window from env safely', () => {
  const lease = new AgentControlLease();
  assert.throws(() => lease.acquire({ browserId: '', agentId: 'codex' }), /browser/);
  assert.throws(() => lease.acquire({ browserId: browserA, agentId: '' }), /agent/);
  assert.equal(idleMsFromEnv({}), 30_000);
  assert.equal(idleMsFromEnv({ WORK_EDGE_AGENT_CONTROL_IDLE_MS: '5000' }), 5_000);
  assert.equal(idleMsFromEnv({ WORK_EDGE_AGENT_CONTROL_IDLE_MS: '5' }), 30_000);
  assert.equal(idleMsFromEnv({ WORK_EDGE_AGENT_CONTROL_IDLE_MS: 'nope' }), 30_000);
});
