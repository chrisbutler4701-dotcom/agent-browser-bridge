import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { allowedUrl } from '../broker/src/server.js';

const root = new URL('../', import.meta.url);

test('self-host broker policy refuses metadata and private network destinations', () => {
  const policy = JSON.parse(readFileSync(new URL('deploy/selfhost/policy.json', root), 'utf8'));
  const denied = [
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.1.1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/latest',
    'http://100.100.100.200/latest/meta-data',
    'http://localhost/admin',
    'https://localhost/admin',
    'http://127.0.0.1/private',
    'https://127.1.2.3/private',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'https://10.255.255.255/',
    'http://192.168.1.1/',
    'https://192.168.255.255/',
    'http://172.16.0.1/',
    'https://172.31.255.255/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ];
  for (const url of denied) assert.equal(allowedUrl(url, policy), false, url);
  assert.equal(allowedUrl('https://example.com/', policy), true);
});

test('Chromium managed policy blocks metadata and local host patterns', () => {
  const policy = JSON.parse(readFileSync(new URL('deploy/cloud-browser/chromium-policy.json', root), 'utf8'));
  assert.deepEqual(policy.URLBlocklist, [
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    'localhost',
    '127.0.0.1',
    '[::1]',
  ]);
});

test('cloud image installs the managed policy for Chromium and Chrome', () => {
  const dockerfile = readFileSync(new URL('deploy/cloud-browser/Dockerfile', root), 'utf8');
  assert.match(dockerfile, /COPY deploy\/cloud-browser\/chromium-policy\.json \/etc\/chromium\/policies\/managed\/fbb\.json/);
  assert.match(dockerfile, /COPY deploy\/cloud-browser\/chromium-policy\.json \/etc\/opt\/chrome\/policies\/managed\/fbb\.json/);
});
