import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTokenStore } from '../broker/src/agent-token-store.js';
import { BrowserCommandQueue } from '../broker/src/command-queue.js';
import { BrowserRegistry } from '../broker/src/browser-registry.js';
import { createServer, PairedTokenStore } from '../broker/src/server.js';
import { invoke } from './http-harness.js';

// The self-host policy is the one customers run; navigation must honour it before any browser sees the URL.
const selfhostPolicy = JSON.parse(readFileSync(new URL('../deploy/selfhost/policy.json', import.meta.url), 'utf8'));
const policy = { ...selfhostPolicy, audit: { enabled: false, includeUrlPath: false } };

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-nav-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'c'.repeat(32);
  const tokenStore = new PairedTokenStore({ filePath: join(directory, 'browser-tokens.json') }); tokenStore.add(token);
  const agents = new AgentTokenStore({ filePath: join(directory, 'agent-tokens.json') });
  const agent = agents.create({ id: 'codex', capabilities: ['browser.read', 'browser.control'] }).token;
  const queue = new BrowserCommandQueue({ stateFile: join(directory, 'commands.json') });
  const registry = new BrowserRegistry({ filePath: join(directory, 'browsers.json') });
  const browser = createHash('sha256').update(token).digest('hex');
  registry.ensure(browser); queue.markOnline(browser, true, '1.0.5');
  const server = createServer({ policy, tokenStore, agentTokenStore: agents, commandQueue: queue, browserRegistry: registry });
  t.after(() => server.close());
  const navigate = async (url) => JSON.parse((await invoke(server, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${agent}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edge_navigate', arguments: { url } } }) })).body);
  return { queue, browser, navigate };
}

for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.20.0.5/', 'http://127.0.0.1:8767/', 'http://localhost/', 'file:///etc/passwd', 'chrome://settings']) {
  test(`navigate to ${url} is refused by broker policy before any browser sees it`, async (t) => {
    const { queue, browser, navigate } = setup(t);
    const response = await navigate(url);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(response.result.isError, true);
    assert.equal(payload.error.code, 'policy_denied');
    assert.equal(await queue.poll(browser, 50, true, '1.0.5'), null, 'no command was queued for the browser');
  });
}

test('navigate to a public https site is still delivered', async (t) => {
  const { queue, browser, navigate } = setup(t);
  const poll = queue.poll(browser, 1_000, true, '1.0.5');
  const pending = navigate('https://example.com/');
  const command = await poll;
  assert.equal(command.type, 'navigate');
  queue.submitResult(browser, command.id, { ok: true, result: { navigated: true } });
  assert.equal((await pending).result.isError, undefined);
});
