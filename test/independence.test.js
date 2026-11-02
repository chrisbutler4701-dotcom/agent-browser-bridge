import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(new URL('..', import.meta.url).pathname);
const excludedDirectories = new Set(['.git', 'node_modules']);
const excludedFiles = new Set(['test/independence.test.js', 'LICENSE', 'NOTICE']);
const forbiddenParts = [
  'infinite' + 'barrz', 'bbos' + '\\.tech', '72' + '\\.61', '2' + '\\.24\\.73',
  '/' + 'root/', '/' + 'Users/', 'chris' + 'butler', 'breaking' + 'ground',
  'ronda', 'aw' + 'ards', 'twin' + 'browser'
];
const forbidden = new RegExp(forbiddenParts.join('|'), 'i');
// The project's own public repository link is allowed; nothing else under that account is.
const publicRepo = new RegExp('github\\.com/' + 'chris' + 'butler4701-dotcom/agent-browser-bridge', 'gi');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : files(path);
    return entry.isFile() ? [path] : [];
  });
}

test('the entire distributable tree is independent of private infrastructure', () => {
  const offenders = files(root).filter((path) => {
    if (excludedFiles.has(relative(root, path))) return false;
    return forbidden.test(readFileSync(path).toString('utf8').replace(publicRepo, ''));
  }).map((path) => relative(root, path));
  assert.deepEqual(offenders, []);
});
