import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmacHandoffControllerAuthenticator, signHandoffControllerRequest } from '../broker/src/handoff-controller-auth.js';

const secret = 'h'.repeat(48);
const now = 1_700_000_000_000;
const request = (headers = {}) => ({ method: 'POST', url: '/work-edge/browser/handoff/claim', headers });

test('handoff adapter accepts only a fresh server-signed controller identity', () => {
  const authenticate = createHmacHandoffControllerAuthenticator({ WORK_EDGE_HANDOFF_AUTH_SECRET: secret }, () => now);
  const headers = signHandoffControllerRequest(secret, { method: 'POST', url: '/work-edge/browser/handoff/claim', id: 'telegram:123', timestamp: now });
  assert.deepEqual(authenticate(request(headers)), { id: 'telegram:123' });
  assert.deepEqual(authenticate(request({ ...headers, authorization: 'Bearer agent-token' })), { id: 'telegram:123' }, 'an agent bearer neither grants nor changes human authority');
  assert.equal(authenticate(request({ ...headers, 'x-work-edge-handoff-controller': 'telegram:456' })), null, 'the caller cannot alter the signed identity');
  assert.equal(authenticate(request({ ...headers, 'x-work-edge-handoff-timestamp': String(now - 60_001) })), null, 'stale host assertions are rejected');
});

test('handoff adapter remains closed without its dedicated server credential', () => {
  const headers = signHandoffControllerRequest(secret, { method: 'POST', url: '/work-edge/browser/handoff/claim', id: 'telegram:123', timestamp: now });
  assert.equal(createHmacHandoffControllerAuthenticator({}, () => now)(request(headers)), null);
});
