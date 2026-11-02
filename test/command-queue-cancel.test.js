import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';

function command(id, agentId) {
  return { id, agentId, type: 'wait', ms: 1, createdAt: new Date(0).toISOString() };
}

test('cancelPendingForAgent cancels queued and delivered commands, resolves waiters, and leaves other agents untouched', async () => {
  const queue = new BrowserCommandQueue({ stateFile: null });
  queue.enqueue('browser-a', command('a-queued', 'agent-a'), 5_000);
  queue.enqueue('browser-a', command('a-delivered', 'agent-a'), 5_000);
  queue.nextForBrowser('browser-a', 1, 1);
  queue.enqueue('browser-b', command('b-queued', 'agent-b'), 5_000);
  const queuedWaiter = queue.waitForResult('browser-a', 'a-queued', 5_000);
  const deliveredWaiter = queue.waitForResult('browser-a', 'a-delivered', 5_000);

  assert.equal(queue.cancelPendingForAgent('agent-a'), 2);
  const expected = { ok: false, error: 'This agent was disconnected, so the command was cancelled.', code: 'agent_revoked' };
  assert.deepEqual(await queuedWaiter, expected);
  assert.deepEqual(await deliveredWaiter, expected);
  assert.equal(queue.record('a-queued').state, 'cancelled');
  assert.equal(queue.record('a-delivered').state, 'cancelled');
  assert.equal(queue.record('b-queued').state, 'queued');
});

test('cancelPendingForAgent never cancels a received command', () => {
  const queue = new BrowserCommandQueue({ stateFile: null });
  queue.enqueue('browser-a', command('already-received', 'agent-a'), 5_000);
  queue.record('already-received').state = 'received';
  assert.equal(queue.cancelPendingForAgent('agent-a'), 0);
  assert.equal(queue.record('already-received').state, 'received');
});

test('browser revocation separates cancellable and received commands', async () => {
  const queue = new BrowserCommandQueue({ stateFile: null });
  queue.enqueue('browser-a', command('queued', 'agent-a'), 5_000);
  queue.enqueue('browser-a', command('received', 'agent-a'), 5_000);
  queue.record('received').state = 'received';
  const queuedResult = queue.waitForResult('browser-a', 'queued', 5_000);
  const receivedResult = queue.waitForResult('browser-a', 'received', 5_000);
  assert.deepEqual(queue.cancelPendingForBrowser('browser-a'), { cancelled: 1, revokedInFlight: 1 });
  assert.equal(queue.record('queued').state, 'cancelled');
  assert.equal(queue.record('received').state, 'revoked_in_flight');
  assert.equal((await queuedResult).code, 'browser_revoked');
  assert.deepEqual(await receivedResult, { ok: false, code: 'revoked_in_flight', error: 'Browser access was revoked after the command was received; it may have run.' });
  assert.equal(queue.submitResult('browser-a', 'received', { ok: true }), false);
  assert.deepEqual(queue.cancelPendingForBrowser('browser-a'), { cancelled: 0, revokedInFlight: 0 });
});

test('nextForBrowser and poll never deliver cancelled records', async () => {
  const queue = new BrowserCommandQueue({ stateFile: null });
  queue.enqueue('browser-a', command('cancelled-next', 'agent-a'), 5_000);
  queue.cancelPendingForAgent('agent-a');
  assert.equal(queue.nextForBrowser('browser-a'), null);

  queue.enqueue('browser-b', command('cancelled-poll', 'agent-a'), 5_000);
  queue.cancelPendingForAgent('agent-a');
  assert.equal(await queue.poll('browser-b', 1, true, '1.0.7'), null);
});
