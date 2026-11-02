import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canUseTool, visibleTools } from '../broker/src/agent-capabilities.js';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { ALL_TOOLS } from '../broker/src/tools.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-agents-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, filePath: join(directory, 'agents.json') };
}

test('agent tokens are stored only as hashes in a private file', (t) => {
  const value = fixture(t);
  const store = new AgentTokenStore(value);
  const token = 'a'.repeat(32);
  store.add(token, { id: 'hermes', capabilities: ['browser.read', 'browser.control'] });
  const raw = readFileSync(value.filePath, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(statSync(value.filePath).mode & 0o777, 0o600);
  assert.deepEqual(store.authenticate(token), {
    id: 'hermes', capabilities: ['browser.control', 'browser.read'], source: 'agent-token-store',
  });
  assert.equal(store.authenticate('b'.repeat(32)), null);
});

test('revocation immediately invalidates an agent token without deleting its audit identity', (t) => {
  const value = fixture(t);
  const store = new AgentTokenStore(value);
  const token = 'c'.repeat(32);
  store.add(token, { id: 'codex', capabilities: ['browser.verified.propose'] });
  assert.equal(store.activeCount(), 1);
  assert.equal(store.revoke('codex'), true);
  assert.equal(store.authenticate(token), null);
  assert.equal(store.activeCount(), 0);
  assert.equal(store.list()[0].id, 'codex');
  assert.equal(typeof store.list()[0].revokedAt, 'string');
  store.add('e'.repeat(32), { id: 'codex', capabilities: ['browser.read'] });
  assert.equal(store.authenticate(token), null);
  assert.equal(store.authenticate('e'.repeat(32)).id, 'codex');
  assert.equal(store.list()[0].credentialVersion, 2);
});

test('unknown grants and malformed durable identity data fail closed', (t) => {
  const value = fixture(t);
  const store = new AgentTokenStore(value);
  assert.throws(() => store.add('d'.repeat(32), { id: 'bad id', capabilities: ['browser.read'] }), /agent id/);
  assert.throws(() => store.add('d'.repeat(32), { id: 'agent', capabilities: ['filesystem.home'] }), /unknown agent capability/);
  writeFileSync(value.filePath, JSON.stringify({ version: 1, principals: [{ id: 'x', tokenHash: '0'.repeat(64), capabilities: ['filesystem.home'], createdAt: new Date().toISOString() }] }));
  assert.throws(() => store.activeCount(), /unreadable/);
});

test('tool discovery and direct authorization use the same capability map', () => {
  const reader = { id: 'reader', capabilities: ['browser.read'] };
  const controller = { id: 'controller', capabilities: ['browser.control'] };
  const readerTools = visibleTools(ALL_TOOLS, reader).map((tool) => tool.name);
  const controllerTools = visibleTools(ALL_TOOLS, controller).map((tool) => tool.name);
  assert.equal(readerTools.includes('edge_snapshot'), true);
  assert.equal(readerTools.includes('edge_screenshot'), true);
  assert.equal(readerTools.includes('edge_click'), false);
  assert.equal(controllerTools.includes('edge_click'), true);
  assert.equal(controllerTools.includes('edge_screenshot'), false);
  assert.equal(canUseTool(reader, 'edge_screenshot'), true);
  assert.equal(canUseTool(controller, 'edge_screenshot'), false);
  assert.equal(controllerTools.includes('edge_find_elements'), true);
  assert.equal(canUseTool(reader, 'edge_find_elements', { scope: 'live' }), false);
  assert.equal(canUseTool(controller, 'edge_find_elements', { scope: 'live' }), true);
});

test('provisioning CLI creates a one-time token, lists grants, and revokes by id', (t) => {
  const value = fixture(t);
  const env = { ...process.env, WORK_EDGE_AGENT_TOKEN_STORE: value.filePath };
  const create = spawnSync(process.execPath, ['scripts/agent-token.js', 'create', '--id', 'hermes', '--cap', 'browser.read,browser.verified.propose'], { encoding: 'utf8', env });
  assert.equal(create.status, 0, create.stderr);
  const credential = JSON.parse(create.stdout);
  assert.equal(typeof credential.token, 'string');
  assert.equal(credential.token.length >= 32, true);

  const list = spawnSync(process.execPath, ['scripts/agent-token.js', 'list'], { encoding: 'utf8', env });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.includes(credential.token), false);
  assert.deepEqual(JSON.parse(list.stdout)[0].capabilities, ['browser.read', 'browser.verified.propose']);

  const revoke = spawnSync(process.execPath, ['scripts/agent-token.js', 'revoke', '--id', 'hermes'], { encoding: 'utf8', env });
  assert.equal(revoke.status, 0, revoke.stderr);
  assert.equal(new AgentTokenStore(value).authenticate(credential.token), null);
});
