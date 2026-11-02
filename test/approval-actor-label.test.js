import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalActorLabel } from '../broker/src/server.js';

test('approval labels require browser management and bounded plain text', () => {
  const manager = { capabilities: ['manage_browser_privacy'] };
  assert.equal(approvalActorLabel(manager, 'Gemma via Cockpit'), 'Gemma via Cockpit');
  assert.equal(approvalActorLabel({ capabilities: ['browser.control'] }, 'Gemma via Cockpit'), null);
  assert.equal(approvalActorLabel(manager, 'X'.repeat(61)), null);
  assert.equal(approvalActorLabel(manager, 'Gemma <script>'), null);
});
