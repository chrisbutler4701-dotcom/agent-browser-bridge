import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCloudReceived, readReview } from '../broker/src/cloud-received.js';

test('two private read responses retain their exact scrubbed bytes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-cloud-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = createCloudReceived({ directory });
  const runId = '0199d63f-0a5a-7000-8000-000000000001';
  const responses = ['[CLIENT-1] had a visit.', '[CLIENT-2] needs a follow-up.'].map((text, index) =>
    JSON.stringify({ jsonrpc: '2.0', id: index + 1, result: { content: [{ type: 'text', text: JSON.stringify({ text }) }] } }));
  for (const bytes of responses) await log.append(runId, { at: new Date().toISOString(), tool: 'edge_extract_text', bytes });
  const merged = [{ kind: 'prompt_context', text: 'Summarize this page' }, ...(await log.read(runId))];
  assert.deepEqual(merged.slice(1).map((item) => item.bytes), responses);
  assert.ok(merged.some((item) => JSON.stringify(item).includes('[CLIENT-1]')));
  assert.ok(merged.some((item) => JSON.stringify(item).includes('[CLIENT-2]')));
  assert.equal(JSON.stringify(merged).includes('Maya Rivera'), false);
});

test('second dense read is held; cancellation is not a received response', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fbb-cloud-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = createCloudReceived({ directory });
  const runId = '0199d63f-0a5a-7000-8000-000000000002';
  const first = { result: { content: [{ type: 'text', text: JSON.stringify({ text: '[CLIENT-1]' }) }] } };
  const second = { result: { content: [{ type: 'text', text: JSON.stringify({ text: '[CLIENT-1]', swapReview: { count: 14, textLength: 500, counts: { '[CLIENT-1]': 6 } } }) }] } };
  assert.equal(readReview(first), null);
  assert.match(readReview(second).label, /Replaced 14 details: \[CLIENT-1\] ×6/u);
  await log.append(runId, { at: new Date().toISOString(), tool: 'edge_snapshot', bytes: JSON.stringify(first) });
  // Cancel never calls append for the held payload.
  assert.equal((await log.read(runId)).length, 1);
});
