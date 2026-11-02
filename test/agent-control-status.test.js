import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { describeAgentControl } from '../extension/agent-control-status.js';

test('describes the acting agent in plain words', () => {
  assert.equal(describeAgentControl(null, 0), 'No agent has acted on this browser yet.');
  assert.equal(describeAgentControl({ agentId: 42 }, 0), 'No agent has acted on this browser yet.');
  assert.equal(describeAgentControl({ agentId: 'codex', at: 10_000 }, 15_000), 'codex is acting now (last action 5 seconds ago).');
  assert.equal(describeAgentControl({ agentId: 'codex', at: 0 }, 31_000), 'Last action by codex, 1 minute ago.');
  assert.equal(describeAgentControl({ agentId: 'codex', at: 0 }, 300_000), 'Last action by codex, 5 minutes ago.');
});

test('the worker records the acting agent and the panel renders agent and browser identity as text', () => {
  const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../extension/command-runner-worker.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  assert.match(worker, /lastActingAgent/);
  assert.match(runner, /browser-identity/);
  assert.match(html, /id="agentControlStatus"/);
  assert.match(panel, /agentControlStatus\.textContent = describeAgentControl\(/);
  assert.doesNotMatch(panel, /agentControlStatus\.innerHTML/);
  assert.match(html, /id="browserIdentity"/);
  assert.match(panel, /browserIdentity\.textContent/);
  assert.doesNotMatch(panel, /browserIdentity\.innerHTML/);
});
