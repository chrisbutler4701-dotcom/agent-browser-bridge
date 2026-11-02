import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBrowserCommand } from '../extension/command-executor.js';

test('scrolls a main container when the document cannot scroll and reports its position', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const container = {
    scrollTop: 100,
    scrollHeight: 2400,
    clientHeight: 600,
    scrollBy({ top }) { this.scrollTop += top; }
  };
  globalThis.window = { scrollY: 0, innerHeight: 600, scrollBy() { throw new Error('document should not scroll'); } };
  globalThis.document = {
    scrollingElement: { scrollHeight: 600, clientHeight: 600 },
    querySelectorAll() { return [container]; }
  };
  try {
    const outcome = executeBrowserCommand({ type: 'scroll', direction: 'down', amount: 400 });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, { scrolled: true, scrollY: 500, scrollHeight: 2400, viewportHeight: 600 });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
