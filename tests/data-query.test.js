import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { createDataTransaction, createTransaction } from '../src/core/transaction.js';
import { generateKeyPair, publicKeyToAddress } from '../src/core/crypto.js';

function setupDAGWithData() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);

  const pair = generateKeyPair();
  const address = publicKeyToAddress(pair.publicKey);
  dag.balances.set(address, 10_000);

  const tips = dag.selectTips();

  // Add several data transactions
  const tx1 = createDataTransaction({
    senderSecretKey: pair.secretKey,
    senderPublicKey: pair.publicKey,
    parents: tips,
    metadata: { type: 'message', content: 'hello world', channel: 'general' },
  });
  dag.addTransaction(tx1);

  const tx2 = createDataTransaction({
    senderSecretKey: pair.secretKey,
    senderPublicKey: pair.publicKey,
    parents: dag.selectTips(),
    metadata: { type: 'request', service: 'translation', lang: 'es' },
  });
  dag.addTransaction(tx2);

  const tx3 = createDataTransaction({
    senderSecretKey: pair.secretKey,
    senderPublicKey: pair.publicKey,
    parents: dag.selectTips(),
    metadata: { type: 'message', content: 'goodbye', channel: 'general' },
  });
  dag.addTransaction(tx3);

  // Add a transfer (non-data) to verify it's excluded
  const txTransfer = createTransaction({
    senderSecretKey: pair.secretKey,
    senderPublicKey: pair.publicKey,
    to: 'iotai_bob',
    amount: 100,
    parents: dag.selectTips(),
  });
  dag.addTransaction(txTransfer);

  return { dag, pair, address, txIds: [tx1.id, tx2.id, tx3.id] };
}

describe('DAG.queryData', () => {
  it('returns all data transactions with no filters', () => {
    const { dag } = setupDAGWithData();
    const result = dag.queryData();
    assert.equal(result.total, 3);
    assert.equal(result.transactions.length, 3);
  });

  it('filters by sender address', () => {
    const { dag, address } = setupDAGWithData();
    const result = dag.queryData({ from: address });
    assert.equal(result.total, 3);

    const none = dag.queryData({ from: 'iotai_unknown' });
    assert.equal(none.total, 0);
  });

  it('filters by metadata key', () => {
    const { dag } = setupDAGWithData();
    const result = dag.queryData({ key: 'service' });
    assert.equal(result.total, 1);
    assert.equal(result.transactions[0].metadata.service, 'translation');
  });

  it('filters by metadata key + value', () => {
    const { dag } = setupDAGWithData();
    const result = dag.queryData({ key: 'type', value: 'message' });
    assert.equal(result.total, 2);
  });

  it('filters by time range (since)', () => {
    const { dag } = setupDAGWithData();
    const farFuture = Date.now() + 100000;
    const result = dag.queryData({ since: farFuture });
    assert.equal(result.total, 0);
  });

  it('respects limit and offset', () => {
    const { dag } = setupDAGWithData();
    const page1 = dag.queryData({ limit: 2, offset: 0 });
    assert.equal(page1.transactions.length, 2);
    assert.equal(page1.total, 3);

    const page2 = dag.queryData({ limit: 2, offset: 2 });
    assert.equal(page2.transactions.length, 1);
  });

  it('excludes non-data transactions', () => {
    const { dag } = setupDAGWithData();
    const result = dag.queryData();
    for (const tx of result.transactions) {
      assert.equal(tx.type, 'data');
    }
  });

  it('returns newest first', () => {
    const { dag } = setupDAGWithData();
    const result = dag.queryData();
    for (let i = 1; i < result.transactions.length; i++) {
      assert.ok(result.transactions[i - 1].timestamp >= result.transactions[i].timestamp);
    }
  });
});

describe('DAG.searchData', () => {
  it('finds by text in metadata', () => {
    const { dag } = setupDAGWithData();
    const results = dag.searchData('hello');
    assert.equal(results.length, 1);
    assert.equal(results[0].metadata.content, 'hello world');
  });

  it('is case-insensitive', () => {
    const { dag } = setupDAGWithData();
    const results = dag.searchData('TRANSLATION');
    assert.equal(results.length, 1);
  });

  it('returns empty for no match', () => {
    const { dag } = setupDAGWithData();
    const results = dag.searchData('nonexistent_xyz');
    assert.equal(results.length, 0);
  });

  it('respects limit', () => {
    const { dag } = setupDAGWithData();
    const results = dag.searchData('general', 1);
    assert.equal(results.length, 1);
  });

  it('finds across multiple metadata fields', () => {
    const { dag } = setupDAGWithData();
    const results = dag.searchData('es');
    assert.ok(results.length >= 1);
  });
});
