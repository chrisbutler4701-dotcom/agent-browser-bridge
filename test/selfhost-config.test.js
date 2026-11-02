import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { OAuthProvider } from '../broker/src/oauth.js';
import { createServer, loadPolicy, prepareStartupEnv, statePaths } from '../broker/src/server.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 }, allowOrigins: ['*'], denyUrlPrefixes: [],
  capture: { maxTextCharacters: 2_000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: false, includeUrlPath: false }
};

test('production startup requires PUBLIC_BASE_URL', () => {
  assert.throws(() => createServer({ policy, env: { NODE_ENV: 'production', FBB_DATA_DIR: '/tmp/fbb-test-data' } }), /PUBLIC_BASE_URL is required/);
  assert.throws(() => new OAuthProvider({}), /publicBaseUrl is required/);
});

test('state paths resolve under FBB_DATA_DIR and container listen defaults publicly', () => {
  const paths = statePaths({ FBB_DATA_DIR: '/tmp/customer-fbb' });
  for (const value of Object.values(paths)) assert.equal(value.startsWith(resolve('/tmp/customer-fbb') + '/'), true, value);
  assert.equal(loadPolicy({ FBB_IN_CONTAINER: '1' }).listen.host, '0.0.0.0');
});

test('first-boot generation is scoped to self-host data-directory startup', () => {
  const existingHostEnv = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://bridge.example.com' };
  assert.equal(prepareStartupEnv(existingHostEnv), existingHostEnv);
  assert.equal(existingHostEnv.WORK_EDGE_MCP_TOKEN, undefined);
});

test('self-host artifacts define the persistent data volume and three setup commands', () => {
  const compose = readFileSync(new URL('../deploy/selfhost/docker-compose.yml', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../deploy/selfhost/README.md', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const dockerignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.match(compose, /FBB_DATA_DIR: \/data/);
  assert.match(compose, /fbb-data:\/data/);
  assert.match(readme, /docker compose up -d/);
  assert.match(readme, /npm run pair-code/);
  assert.match(readme, /npm run agent-token -- create --id my-agent --cap browser\.read,browser\.control/);
  assert.match(readme, /Caddy/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  for (const excluded of ['.git', 'node_modules', 'dist', 'data', 'config.json', '*.log']) assert.equal(dockerignore.split('\n').includes(excluded), true, excluded);
});

test('self-host image, compose and policy agree on port 8767 and enable screenshots', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const docker = read('Dockerfile'); const compose = read('deploy/selfhost/docker-compose.yml');
  const policy = JSON.parse(read('deploy/selfhost/policy.json'));
  assert.match(docker, /ENV FBB_LISTEN_PORT=8767/);
  assert.match(docker, /ENV WORK_EDGE_POLICY=\/app\/deploy\/selfhost\/policy\.json/);
  assert.equal(policy.listen.port, 8767);
  assert.equal(policy.capture.screenshotEnabled, true);
  assert.match(compose, /:8767"\]/);
  assert.match(compose, /http:\/\/broker:8767\/work-edge\/ingest/);
});

test('owner-token startup guidance is printed only inside the broker container', async (t) => {
  const directories = [];
  t.after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));
  const start = (inContainer) => new Promise((resolveOutput, reject) => {
    const directory = mkdtempSync(`${tmpdir()}/fbb-startup-`);
    directories.push(directory);
    const child = spawn(process.execPath, ['broker/src/server.js'], {
      cwd: new URL('../', import.meta.url),
      env: {
        ...process.env,
        FBB_DATA_DIR: directory,
        FBB_LISTEN_HOST: '127.0.0.1',
        FBB_LISTEN_PORT: '0',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8767',
        ...(inContainer ? { FBB_IN_CONTAINER: '1' } : { FBB_IN_CONTAINER: '' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Field Browser Bridge on ')) setTimeout(() => child.kill('SIGTERM'), 20);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', () => stderr ? reject(new Error(stderr)) : resolveOutput(stdout));
  });

  let hostOutput;
  try { hostOutput = await start(false); }
  catch (error) {
    if (/listen EPERM: operation not permitted 127\.0\.0\.1/.test(error.message)) return t.skip('The sandbox does not permit loopback listeners.');
    throw error;
  }
  assert.match(hostOutput, /Field Browser Bridge on /);
  assert.doesNotMatch(hostOutput, /npm run owner-token/);
  const containerOutput = await start(true);
  assert.match(containerOutput, /npm run owner-token/);
});

test('pair-code talks to the local broker inside the container, not the public address', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../scripts/pair-code.js', import.meta.url), 'utf8');
  const fn = new Function('env', source.match(/export function adminBaseUrl\(env = process\.env\) \{([\s\S]*?)\n\}/)[1]);
  assert.equal(fn({ FBB_IN_CONTAINER: '1', PUBLIC_BASE_URL: 'https://fbb.example.com' }), 'http://127.0.0.1:8767');
  assert.equal(fn({ FBB_IN_CONTAINER: '1', FBB_LISTEN_PORT: '9000' }), 'http://127.0.0.1:9000');
  assert.equal(fn({ FBB_ADMIN_URL: 'http://broker:8767/' }), 'http://broker:8767');
  assert.equal(fn({ PUBLIC_BASE_URL: 'https://fbb.example.com/' }), 'https://fbb.example.com');
});
