import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('cloud compose requires the shipped seccomp profile and drops all capabilities', () => {
  const compose = readFileSync(new URL('deploy/selfhost/docker-compose.yml', root), 'utf8');
  assert.match(compose, /security_opt:\s*\n\s*- seccomp=\.\/cloud-browser-seccomp\.json\s*\n\s*- no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.match(compose, /cap_add:\s*\[SYS_CHROOT\]/, 'only SYS_CHROOT is added back');
  assert.doesNotMatch(compose, /SYS_ADMIN|NET_ADMIN|privileged:\s*true|unconfined/);
  assert.doesNotMatch(compose, /privileged\s*:/);
  assert.doesNotMatch(compose, /seccomp=unconfined/);
});

test('self-host seccomp profile is byte-identical to the vendored Playwright profile', () => {
  const vendored = readFileSync(new URL('deploy/cloud-browser/seccomp-profile.json', root));
  const selfhost = readFileSync(new URL('deploy/selfhost/cloud-browser-seccomp.json', root));
  assert.deepEqual(selfhost, vendored);
});

test('production refuses an explicit no-sandbox launch', () => {
  const result = spawnSync('sh', ['deploy/cloud-browser/entrypoint.sh'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    env: { ...process.env, FBB_CLOUD_NO_SANDBOX: '1', FBB_ENTRYPOINT_DRY_RUN: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FBB_CLOUD_NO_SANDBOX=1 is allowed only when FBB_ENV=development/);
});

test('development may explicitly disable the sandbox', () => {
  const output = execFileSync('sh', ['deploy/cloud-browser/entrypoint.sh'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    env: { ...process.env, FBB_ENV: 'development', FBB_CLOUD_NO_SANDBOX: '1', FBB_ENTRYPOINT_DRY_RUN: '1' },
  });
  assert.match(output, /--no-sandbox/);
});

test('pairing helper verifies chrome sandbox before extension pairing', () => {
  const source = readFileSync(new URL('deploy/cloud-browser/pair.mjs', root), 'utf8');
  const sandboxPage = source.indexOf("chrome://sandbox");
  const adequateCheck = source.indexOf('You are adequately sandboxed');
  const extensionWorker = source.indexOf('context.serviceWorkers()');
  assert.ok(sandboxPage >= 0, 'opens chrome://sandbox');
  assert.ok(adequateCheck > sandboxPage, 'checks the sandbox status text');
  assert.ok(extensionWorker > adequateCheck, 'verifies sandbox before pairing logic');
});
