import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRegistry } from '../broker/src/browser-registry.js';

const dA = 'a'.repeat(64), dB = 'b'.repeat(64);
function dir(t) { const d = mkdtempSync(join(tmpdir(), 'fbb-reg-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('first browser becomes default; later ones do not; ids are opaque and stable', (t) => {
  const d = dir(t);
  const reg = new BrowserRegistry({ filePath: join(d, 'browsers.json') });
  const a = reg.ensure(dA); const b = reg.ensure(dB);
  assert.match(a.id, /^brw_[a-f0-9]{16}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(a.isDefault, true); assert.equal(b.isDefault, false);
  assert.equal(a.name, 'Browser 1'); assert.equal(b.name, 'Browser 2');
  assert.equal(a.askBeforeFinalActions, true);
  assert.equal(reg.ensure(dA).id, a.id, 'ensure is idempotent');
  assert.equal(JSON.stringify(reg.list()).includes(dA), false, 'digest never leaves the registry');
  const reopened = new BrowserRegistry({ filePath: join(d, 'browsers.json') });
  assert.equal(reopened.byId(a.id), dA);
  assert.equal(statSync(join(d, 'browsers.json')).mode & 0o777, 0o600);
});

test('missing final-action setting defaults to asking and private browsers force asking', (t) => {
  const reg = new BrowserRegistry({ filePath: join(dir(t), 'browsers.json') });
  const browser = reg.ensure(dA);
  assert.equal(reg.byDigest(dA).askBeforeFinalActions, true);
  reg.setAskBeforeFinalActions(browser.id, false);
  assert.equal(reg.byDigest(dA).askBeforeFinalActions, false);
  reg.setPrivate(browser.id, true);
  assert.equal(reg.byDigest(dA).askBeforeFinalActions, true);
  assert.throws(() => reg.setAskBeforeFinalActions(browser.id, false), /Private browsers/);
});

test('replacement digest keeps identity and browser settings', (t) => {
  const reg = new BrowserRegistry({ filePath: join(dir(t), 'browsers.json') });
  const browser = reg.ensure(dA);
  reg.rename(browser.id, 'Office laptop');
  reg.setAskBeforeFinalActions(browser.id, false);
  const { oldDigest } = reg.replaceToken(browser.id, dB);
  assert.equal(oldDigest, dA);
  assert.equal(reg.byDigest(dA), null);
  assert.deepEqual(reg.byDigest(dB), { ...reg.byDigest(dB), id: browser.id, name: 'Office laptop',
    private: false, askBeforeFinalActions: false, isDefault: true });
});

test('default changes only by explicit call; rename; remove clears default without promoting another', (t) => {
  const reg = new BrowserRegistry({ filePath: join(dir(t), 'browsers.json') });
  const a = reg.ensure(dA); const b = reg.ensure(dB);
  reg.setDefault(b.id); assert.equal(reg.defaultDigest(), dB);
  assert.equal(reg.rename(b.id, 'Office laptop').name, 'Office laptop');
  assert.throws(() => reg.rename(b.id, ''), /name/);
  assert.equal(reg.remove(b.id), true);
  assert.equal(reg.defaultDigest(), null, 'no silent promotion of another browser');
  assert.equal(reg.byId(a.id), dA);
});

test('migrates the legacy single selection into the default', (t) => {
  const d = dir(t);
  writeFileSync(join(d, 'browser-selection.json'), JSON.stringify({ version: 1, browserId: dB }));
  const reg = new BrowserRegistry({ filePath: join(d, 'browsers.json'), legacySelectionFile: join(d, 'browser-selection.json') });
  reg.ensure(dA);
  assert.equal(reg.defaultDigest(), dB);
  assert.equal(reg.byDigest(dB).isDefault, true);
});

test('a corrupt registry fails closed', (t) => {
  const d = dir(t);
  const filePath = join(d, 'browsers.json');
  writeFileSync(filePath, '{broken');
  const reg = new BrowserRegistry({ filePath });
  assert.throws(() => reg.defaultDigest(), /Browser registry is unreadable/);
});

test('legacy migration is persisted on first read, so ids are stable before any browser connects', (t) => {
  const d = dir(t);
  writeFileSync(join(d, 'browser-selection.json'), JSON.stringify({ version: 1, browserId: dB }));
  const reg = new BrowserRegistry({ filePath: join(d, 'browser-registry.json'), legacySelectionFile: join(d, 'browser-selection.json') });
  const first = reg.list(); const second = reg.list();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, second[0].id, 'same id on every read');
  assert.equal(reg.byId(first[0].id), dB);
  assert.equal(new BrowserRegistry({ filePath: join(d, 'browser-registry.json') }).list()[0].id, first[0].id, 'persisted to disk');
});

test('server and CLI resolve the same registry location', async () => {
  const { registryPaths } = await import('../broker/src/browser-registry.js');
  const paths = registryPaths({ WORK_EDGE_TOKEN_STORE: '/var/lib/fbb/browser-tokens.json' });
  assert.equal(paths.filePath, '/var/lib/fbb/browser-registry.json');
  assert.equal(paths.legacySelectionFile, '/var/lib/fbb/browser-selection.json');
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../scripts/browser.js', import.meta.url), 'utf8'), /registryPaths\(/);
  assert.match(readFileSync(new URL('../broker/src/server.js', import.meta.url), 'utf8'), /registryPaths\(/);
});
