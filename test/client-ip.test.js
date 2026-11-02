import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIp } from '../broker/src/client-ip.js';

const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });

test('uses the socket address unless the request came through a trusted proxy', () => {
  assert.equal(clientIp(req('198.51.100.7', '203.0.113.1'), []), '198.51.100.7');
  assert.equal(clientIp(req('172.18.0.5', '203.0.113.1, 172.18.0.5'), ['172.18.0.5']), '203.0.113.1');
  assert.equal(clientIp(req('::ffff:172.18.0.5', '203.0.113.1'), ['172.18.0.5']), '203.0.113.1');
  assert.equal(clientIp(req('198.51.100.7', 'garbage'), ['172.18.0.5']), '198.51.100.7');
});
