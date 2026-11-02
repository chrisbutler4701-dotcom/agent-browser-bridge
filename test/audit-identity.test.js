import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

const policy = {
  listen: { host: '127.0.0.1', port: 0 },
  allowOrigins: ['*'],
  denyUrlPrefixes: ['edge://', 'chrome://', 'file://', 'about:'],
  capture: { maxTextCharacters: 2000, screenshotEnabled: false, retentionSeconds: 300 },
  audit: { enabled: true, includePayloadContent: false, includeUrlPath: false },
};

function call(server, token, id, name, args = {}) {
  return invoke(server, {
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
}

test('audit lines identify agent, public browser, command, time, and outcome without payload secrets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentToken = 'audit-owner-bearer-token';
  const browserToken = 'audit-browser-token';
  const browserDigest = createHash('sha256').update(browserToken).digest('hex');
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  const browser = browserRegistry.ensure(browserDigest);
  const commandQueue = new BrowserCommandQueue({ stateFile: '' });
  let output = '';
  const server = createServer({
    policy,
    tokenStore,
    browserRegistry,
    commandQueue,
    auditWriter: (line) => { output += line; },
    env: { WORK_EDGE_MCP_TOKEN: agentToken, WORK_EDGE_MCP_ID: 'audit-agent', FBB_DATA_DIR: directory },
  });

  const runCommand = async (id, name, args, result) => {
    const polled = commandQueue.poll(browserDigest, 500, true, '1.0.5', 'polling_recovery_active');
    const called = call(server, agentToken, id, name, args);
    const command = await polled;
    assert.ok(command?.id);
    commandQueue.submitResult(browserDigest, command.id, { ok: true, result });
    const response = await called;
    assert.equal(response.status, 200);
  };

  await runCommand(1, 'edge_type', { selector: '#safe', text: 'SECRET-TYPED-VALUE' }, { typed: true });
  await runCommand(2, 'edge_navigate', { url: 'https://example.com/audit' }, { navigated: true });
  const status = await call(server, agentToken, 3, 'edge_status');
  assert.equal(status.status, 200);

  assert.notEqual(output.trim(), '', 'audit writer receives one JSON line per call');
  const lines = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.event, 'work_edge_tool_call');
    assert.equal(line.agentId, 'audit-agent');
    assert.equal(line.browserId, browser.id);
    assert.match(line.browserId, /^brw_[a-f0-9]{16}$/);
    assert.equal(new Date(line.timestamp).toISOString(), line.timestamp);
    assert.equal(typeof line.outcome, 'string');
  }
  assert.equal(lines[0].tool, 'edge_type');
  assert.match(lines[0].commandId, /^[a-f0-9]{16}$/);
  assert.equal(lines[1].tool, 'edge_navigate');
  assert.match(lines[1].commandId, /^[a-f0-9]{16}$/);
  assert.equal(lines[2].tool, 'edge_status');
  assert.equal(lines[2].commandId, null);

  assert.equal(output.includes('SECRET-TYPED-VALUE'), false);
  assert.equal(output.includes(agentToken), false);
  assert.equal(output.includes(browserToken), false);
  assert.equal(output.includes(browserDigest), false);
});

test('every early tools/call response writes exactly one identity-safe audit line', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-audit-early-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentToken = 'early-audit-owner-bearer-token';
  const browserToken = 'early-audit-browser-token';
  const browserDigest = createHash('sha256').update(browserToken).digest('hex');
  const offlineDigest = createHash('sha256').update('offline-browser-token').digest('hex');
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') });
  tokenStore.add(browserToken);
  const browserRegistry = new BrowserRegistry({ filePath: join(directory, 'browser-registry.json') });
  const browser = browserRegistry.ensure(browserDigest);
  const offlineBrowser = browserRegistry.ensure(offlineDigest);
  const commandQueue = new BrowserCommandQueue({ stateFile: '' });
  commandQueue.markOnline(browserDigest, true, '1.0.7', 'polling_recovery_active');
  const transaction = (transactionId) => ({
    phase: 'proposed',
    proposal: { transactionId, actor: { agentId: 'early-audit-agent' }, target: { browserId: browserDigest } },
  });
  const verifiedActions = {
    get(transactionId) {
      return ['txn-status-found', 'txn-receipt-found'].includes(transactionId) ? transaction(transactionId) : null;
    },
  };
  let receiptTransactionId = null;
  const receiptStore = {
    get(transactionId) {
      receiptTransactionId = transactionId;
      return ['txn-receipt-found', 'txn-receipt-invalid'].includes(transactionId) ? { transactionId } : null;
    },
    verifyChain() {
      if (receiptTransactionId === 'txn-receipt-invalid') throw new Error('Receipt chain is invalid.');
      return { valid: true, count: 1, head: 'receipt-head' };
    },
  };
  const lines = [];
  const server = createServer({
    policy,
    tokenStore,
    browserRegistry,
    commandQueue,
    verifiedActions,
    receiptStore,
    auditWriter: (line) => { lines.push(line); },
    env: { WORK_EDGE_MCP_TOKEN: agentToken, WORK_EDGE_MCP_ID: 'early-audit-agent', FBB_DATA_DIR: directory },
  });
  let id = 100;
  const secret = 'SECRET-EARLY-AUDIT-ARGUMENT';
  const expectAudit = async (name, args, expected) => {
    const before = lines.length;
    const response = await call(server, agentToken, id++, name, { ...args, secret });
    assert.equal(response.status, 200);
    assert.equal(lines.length, before + 1, `${name} writes exactly one audit line`);
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.tool, name);
    assert.equal(entry.outcome, expected.outcome);
    assert.equal(entry.agentId, 'early-audit-agent');
    assert.equal(entry.browserId, expected.browserId);
    assert.equal(entry.commandId, null);
  };

  await expectAudit('edge_list_browsers', {}, { outcome: 'ok', browserId: null });
  await expectAudit('edge_bridge_status', { browserId: browser.id }, { outcome: 'ok', browserId: browser.id });
  await expectAudit('edge_bridge_status', { browserId: 'brw_deadbeefdeadbeef' }, { outcome: 'browser_unknown', browserId: null });
  await expectAudit('edge_bridge_status', { browserId: offlineBrowser.id }, { outcome: 'browser_offline', browserId: offlineBrowser.id });
  await expectAudit('edge_verified_action_status', { transactionId: 'txn-status-found' }, { outcome: 'ok', browserId: browser.id });
  await expectAudit('edge_verified_action_status', { transactionId: 'txn-status-missing' }, { outcome: 'not_found', browserId: null });
  await expectAudit('edge_verified_receipt', { transactionId: 'txn-receipt-found' }, { outcome: 'ok', browserId: browser.id });
  await expectAudit('edge_verified_receipt', { transactionId: 'txn-receipt-missing' }, { outcome: 'not_found', browserId: null });
  await expectAudit('edge_verified_receipt', { transactionId: 'txn-receipt-invalid' }, { outcome: 'not_found', browserId: null });
  await expectAudit('edge_missing_tool', {}, { outcome: 'not_found', browserId: null });
  await expectAudit('edge_status', { browserId: 'brw_deadbeefdeadbeef' }, { outcome: 'browser_unknown', browserId: null });
  await expectAudit('edge_status', { browserId: offlineBrowser.id }, { outcome: 'browser_offline', browserId: offlineBrowser.id });
  browserRegistry.remove(browser.id);
  browserRegistry.remove(offlineBrowser.id);
  await expectAudit('edge_status', {}, { outcome: 'no_default_browser', browserId: null });

  const output = lines.join('');
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(agentToken), false);
  assert.equal(output.includes(browserToken), false);
  assert.equal(output.includes(browserDigest), false);
  assert.equal(output.includes(offlineDigest), false);
});
