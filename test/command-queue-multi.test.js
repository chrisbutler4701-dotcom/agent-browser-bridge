import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);

test('two browsers are online at once and commands never cross', async () => {
  const q = new BrowserCommandQueue({ stateFile: null });
  assert.equal(q.markOnline(A, true, '1.0.4'), true);
  assert.equal(q.markOnline(B, true, '1.0.4'), true);
  assert.deepEqual(q.onlineTokens().sort(), [A, B]);
  q.enqueue(A, { id: 'cmd-a', type: 'wait', ms: 1 }, 5_000);
  const pollB = await q.poll(B, 10, true, '1.0.4');
  assert.equal(pollB, null, 'B never receives A\'s command');
  const pollA = await q.poll(A, 10, true, '1.0.4');
  assert.equal(pollA.id, 'cmd-a');
  q.markOffline(A);
  assert.equal(q.isOnline(A), false); assert.equal(q.isOnline(B), true);
  assert.equal(q.controlEnabled(B), true);
});
