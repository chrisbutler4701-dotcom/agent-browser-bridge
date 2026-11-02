import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { packageExtension } from '../scripts/package-extension.js';

const root = new URL('..', import.meta.url).pathname;
const packaged = (archive, file) => execFileSync('unzip', ['-p', archive, file], { encoding: 'utf8' });

test('package injects optional hosted addresses into defaults, HTML, and permissions', () => {
  const previous = [process.env.FBB_HOSTED_INGEST_URL, process.env.FBB_HOSTED_COCKPIT_URL];
  try {
    process.env.FBB_HOSTED_INGEST_URL = 'https://bridge.example.com/work-edge/ingest';
    process.env.FBB_HOSTED_COCKPIT_URL = 'https://cockpit.example.com/';
    const archive = packageExtension();
    const manifest = JSON.parse(packaged(archive, 'manifest.json'));
    assert.deepEqual(manifest.host_permissions.slice(2), ['https://bridge.example.com/*', 'https://cockpit.example.com/*']);
    assert.match(packaged(archive, 'hosted-default.js'), /https:\/\/bridge\.example\.com\/work-edge\/ingest/);
    assert.match(packaged(archive, 'hosted-default.js'), /https:\/\/cockpit\.example\.com\//);
    assert.match(packaged(archive, 'popup.html'), /value="https:\/\/bridge\.example\.com\/work-edge\/ingest"/);
    assert.match(packaged(archive, 'sidepanel.html'), /value="https:\/\/cockpit\.example\.com\/"/);
  } finally {
    for (const [name, value] of [['FBB_HOSTED_INGEST_URL', previous[0]], ['FBB_HOSTED_COCKPIT_URL', previous[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('package without hosted configuration leaves address fields empty', () => {
  const previous = [process.env.FBB_HOSTED_INGEST_URL, process.env.FBB_HOSTED_COCKPIT_URL];
  try {
    delete process.env.FBB_HOSTED_INGEST_URL;
    delete process.env.FBB_HOSTED_COCKPIT_URL;
    const archive = packageExtension();
    assert.deepEqual(JSON.parse(packaged(archive, 'manifest.json')).host_permissions,
      ['http://127.0.0.1/*', 'http://localhost/*']);
    assert.match(packaged(archive, 'hosted-default.js'), /HOSTED_INGEST_URL = ""/);
    assert.match(packaged(archive, 'popup.html'), /id="brokerUrl" type="url" value=""/);
  } finally {
    for (const [name, value] of [['FBB_HOSTED_INGEST_URL', previous[0]], ['FBB_HOSTED_COCKPIT_URL', previous[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('distributable source has no private hosts or non-loopback IPv4 literals', () => {
  const roots = ['extension', 'broker', 'scripts', 'config'];
  const offenders = [];
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!entry.isFile()) continue;
      const content = readFileSync(file, 'utf8');
      if (/private-example|legacy\.example\.com/iu.test(content)) offenders.push(file);
      for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) {
        if (!['127.0.0.1', '0.0.0.0'].includes(match[0])) offenders.push(file);
      }
    }
  };
  for (const name of roots) scan(join(root, name));
  assert.deepEqual(offenders, []);
});
