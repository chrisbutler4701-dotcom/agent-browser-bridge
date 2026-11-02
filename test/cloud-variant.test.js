import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validateBrokerUrl } from '../extension/broker-url.js';
import { ALLOW_PRIVATE_HTTP } from '../extension/hosted-default.js';
import { packageExtension } from '../scripts/package-extension.js';

test('cloud package changes only host permissions and the CSP connect-src, and enables private HTTP', async () => {
  const outputDirectory = packageExtension({ variant: 'cloud' });
  const sourceManifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const cloudManifest = JSON.parse(readFileSync(new URL('manifest.json', pathToFileURL(`${outputDirectory}/`)), 'utf8'));
  const changedKeys = Object.keys(sourceManifest).filter((key) => JSON.stringify(sourceManifest[key]) !== JSON.stringify(cloudManifest[key]));
  assert.deepEqual(changedKeys.sort(), ['content_security_policy', 'host_permissions']);
  assert.equal(cloudManifest.content_security_policy.extension_pages, sourceManifest.content_security_policy.extension_pages.replace("connect-src 'self'", "connect-src 'self' http: ws:"));
  assert.deepEqual(cloudManifest.host_permissions, ['<all_urls>']);

  assert.equal(ALLOW_PRIVATE_HTTP, false);
  assert.equal(validateBrokerUrl('http://broker:8767/work-edge/ingest'), false);
  const cloudDefaults = await import(`${pathToFileURL(`${outputDirectory}/hosted-default.js`).href}?cloud-defaults=${Date.now()}`);
  const cloudBrokerUrl = await import(`${pathToFileURL(`${outputDirectory}/broker-url.js`).href}?cloud-url=${Date.now()}`);
  assert.equal(cloudDefaults.ALLOW_PRIVATE_HTTP, true);
  assert.equal(cloudBrokerUrl.validateBrokerUrl('http://broker:8767/work-edge/ingest'), true);
});

test('cloud image installs playwright-core where the pairing helper can resolve it', () => {
  const dockerfile = readFileSync(new URL('../deploy/cloud-browser/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /npm install --prefix \/opt\/fbb-cloud --no-save playwright-core@1\.55\.0/);
  assert.match(dockerfile, /WORKDIR \/opt\/fbb-cloud/);
});

test('cloud browser entrypoint clears stale Chromium profile locks so restarts keep the pairing', async () => {
  const { readFileSync } = await import('node:fs');
  const entry = readFileSync(new URL('../deploy/cloud-browser/entrypoint.sh', import.meta.url), 'utf8');
  assert.match(entry, /rm -f \/profile\/SingletonLock \/profile\/SingletonSocket \/profile\/SingletonCookie/);
  assert.ok(entry.indexOf('SingletonLock') < entry.indexOf('--user-data-dir=/profile'), 'locks are cleared before Chromium starts');
});
