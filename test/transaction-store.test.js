import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TransactionStore } from '../broker/src/transaction-store.js';
import { VerifiedActionTransaction, sha256 } from '../broker/src/verified-action.js';

function fixture() {
  return new VerifiedActionTransaction({
    id: 'txn_sealed',
    intent: 'Update synthetic status',
    actor: { agentId: 'test-agent' },
    target: { browserId: 'browser-a', origin: 'https://example.test' },
    beforeHash: sha256({ status: 'old' }),
    changes: [{ field: 'status', to: 'private-new-value' }],
  }).snapshot;
}

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'work-edge-transactions-'));
  return { directory, filePath: join(directory, 'transactions.json'), keyFile: join(directory, 'transactions.key') };
}

test('transaction store seals active proposal values and uses private file modes', (t) => {
  const value = paths();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const store = new TransactionStore(value);
  const snapshot = fixture();
  store.put(snapshot);

  const raw = readFileSync(value.filePath, 'utf8');
  assert.equal(raw.includes('private-new-value'), false);
  assert.equal(raw.includes('Update synthetic status'), false);
  assert.equal(statSync(value.filePath).mode & 0o777, 0o600);
  assert.equal(statSync(value.keyFile).mode & 0o777, 0o600);
  assert.deepEqual(store.list(), [snapshot]);
});

test('transaction store fails closed when authenticated ciphertext is altered', (t) => {
  const value = paths();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const store = new TransactionStore(value);
  store.put(fixture());
  const data = JSON.parse(readFileSync(value.filePath, 'utf8'));
  const ciphertext = data.transactions[0].sealed.ciphertext;
  data.transactions[0].sealed.ciphertext = `${ciphertext.slice(0, -2)}AA`;
  writeFileSync(value.filePath, JSON.stringify(data));
  assert.throws(() => store.list(), /integrity check failed/);
});

test('an existing transaction store cannot be opened without its original key', (t) => {
  const value = paths();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  new TransactionStore(value).put(fixture());
  unlinkSync(value.keyFile);
  assert.throws(() => new TransactionStore(value).list(), /key is missing/);
  assert.throws(() => new TransactionStore(value).put(fixture()), /key is missing/);
});

test('transaction snapshots can be replaced and removed without retaining old plaintext', (t) => {
  const value = paths();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const store = new TransactionStore(value);
  const transaction = VerifiedActionTransaction.restore(fixture());
  store.put(transaction.snapshot);
  const approved = transaction.approve({ approverId: 'worker-1' });
  store.put(approved);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].phase, 'approved');
  assert.equal(store.remove('txn_sealed'), true);
  assert.equal(store.remove('txn_sealed'), false);
  assert.deepEqual(store.list(), []);
});
