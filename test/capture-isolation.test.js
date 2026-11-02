import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureStore } from '../broker/src/server.js';

test('captures are stored and read per browser', () => {
  const s = new CaptureStore({ now: () => Date.parse('2026-10-13T00:00:10Z') });
  s.put('a'.repeat(64), { title: 'A page', url: 'https://a.example', text: 'alpha', capturedAt: '2026-10-13T00:00:00Z' });
  assert.equal(s.latest('a'.repeat(64)).title, 'A page');
  assert.equal(s.latest('b'.repeat(64)), null);
  assert.equal(s.status('b'.repeat(64)).capture, 'unavailable');
  assert.equal(s.status('a'.repeat(64)).capture, 'available');
});
