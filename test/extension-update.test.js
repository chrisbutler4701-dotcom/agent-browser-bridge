import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { OwnerSessions } from '../broker/src/owner-session.js';
import { createServer } from '../broker/src/server.js';

const policy = { listen: { host: '127.0.0.1', port: 0 }, allowOrigins: [], denyUrlPrefixes: [], capture: {}, audit: { enabled: false } };

async function request(server, url, key = '') {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; return response; };
  const req = { method: 'GET', url, headers: { authorization: key ? `Bearer ${key}` : '' } };
  await new Promise((resolve, reject) => {
    response.on('finish', resolve); response.on('error', reject);
    Promise.resolve(server.listeners('request')[0](req, response)).catch(reject);
  });
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

test('extension update selects highest semver, gates access, and downloads exact package', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fbb-extension-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist'); mkdirSync(dist);
  const agents = new AgentTokenStore({ filePath: join(dir, 'agents.json') });
  const allowed = 'a'.repeat(40), denied = 'b'.repeat(40);
  agents.add(allowed, { id: 'cockpit', capabilities: ['manage_browser_privacy'] });
  agents.add(denied, { id: 'reader', capabilities: ['browser.read'] });
  const owners = new OwnerSessions({ passphrase: 'owner-passphrase' });
  const owner = (await owners.signIn({ passphrase: 'owner-passphrase', ip: 'local' })).token;
  const server = createServer({ policy, agentTokenStore: agents, ownerSessions: owners,
    env: { PUBLIC_BASE_URL: 'https://example.test', FBB_DATA_DIR: dir, FBB_EXTENSION_DIST_DIR: dist } });
  t.after(() => server.close());
  const route = '/agent-grants/extension-update';
  assert.equal((await request(server, route)).status, 401);
  assert.equal((await request(server, route, denied)).status, 403);
  assert.deepEqual(JSON.parse((await request(server, route, owner)).body), { error: 'No extension package is available on this server.' });
  writeFileSync(join(dist, 'field-browser-bridge-1.9.9.zip'), 'old');
  const bytes = Buffer.from([0, 1, 2, 255]);
  writeFileSync(join(dist, 'field-browser-bridge-1.10.0.zip'), bytes);
  writeFileSync(join(dist, 'other-99.0.0.zip'), 'ignore');
  mkdirSync(join(dist, 'field-browser-bridge-99.0.0-cloud-'));
  const info = JSON.parse((await request(server, `${route}?file=../../other-99.0.0.zip`, allowed)).body);
  assert.equal(info.version, '1.10.0');
  assert.equal(info.filename, 'field-browser-bridge-1.10.0.zip');
  assert.equal(info.bytes, bytes.length);
  assert.match(info.sha256, /^[a-f0-9]{64}$/u);
  const download = await request(server, `${route}/download?path=../../other-99.0.0.zip`, owner);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, bytes);
  assert.equal(download.headers['content-type'], 'application/zip');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['content-disposition'], 'attachment; filename="field-browser-bridge-1.10.0.zip"');
});
