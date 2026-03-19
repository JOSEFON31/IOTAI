import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { BatchProcessor } from '../src/core/batch.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const sender = new Wallet({ passphrase: 'batch-sender-test' });
  const r1 = new Wallet({ passphrase: 'batch-r1-test' });
  const r2 = new Wallet({ passphrase: 'batch-r2-test' });
  const r3 = new Wallet({ passphrase: 'batch-r3-test' });
  dag.balances.set(sender.address, 100_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 100_000);
  const batch = new BatchProcessor({ dag });
  return { dag, sender, r1, r2, r3, batch };
}

describe('Batch - Execute', () => {
  it('sends to multiple recipients atomically', () => {
    const { dag, sender, r1, r2, r3, batch } = setup();
    const result = batch.executeBatch(sender, dag.selectTips(), {
      transfers: [
        { to: r1.address, amount: 1000 },
        { to: r2.address, amount: 2000 },
        { to: r3.address, amount: 3000 },
      ],
    });

    assert.ok(result.batchId);
    assert.equal(result.count, 3);
    assert.equal(result.totalAmount, 6000);
    assert.ok(result.fee > 0);

    assert.equal(dag.getBalance(r1.address), 1000);
    assert.equal(dag.getBalance(r2.address), 2000);
    assert.equal(dag.getBalance(r3.address), 3000);
  });

  it('charges single fee for entire batch', () => {
    const { dag, sender, r1, r2, batch } = setup();
    const balBefore = dag.getBalance(sender.address);
    const result = batch.executeBatch(sender, dag.selectTips(), {
      transfers: [
        { to: r1.address, amount: 500 },
        { to: r2.address, amount: 500 },
      ],
    });

    const balAfter = dag.getBalance(sender.address);
    // Should deduct totalAmount + single fee
    assert.equal(balBefore - balAfter, result.totalAmount + result.fee);
  });

  it('rejects if insufficient balance', () => {
    const { dag, r1, r2, batch } = setup();
    const poor = new Wallet({ passphrase: 'poor-batch' });
    dag.balances.set(poor.address, 50);
    assert.throws(() => {
      batch.executeBatch(poor, dag.selectTips(), {
        transfers: [{ to: r1.address, amount: 100 }],
      });
    }, /Insufficient balance/);
  });

  it('rejects empty batch', () => {
    const { dag, sender, batch } = setup();
    assert.throws(() => {
      batch.executeBatch(sender, dag.selectTips(), { transfers: [] });
    }, /At least one/);
  });

  it('rejects self-transfer in batch', () => {
    const { dag, sender, batch } = setup();
    assert.throws(() => {
      batch.executeBatch(sender, dag.selectTips(), {
        transfers: [{ to: sender.address, amount: 100 }],
      });
    }, /Cannot send to yourself/);
  });

  it('rejects batch over 100 transfers', () => {
    const { dag, sender, r1, batch } = setup();
    const transfers = Array.from({ length: 101 }, () => ({ to: r1.address, amount: 1 }));
    assert.throws(() => {
      batch.executeBatch(sender, dag.selectTips(), { transfers });
    }, /Max 100/);
  });
});

describe('Batch - Queries', () => {
  it('getBatch returns batch details', () => {
    const { dag, sender, r1, batch } = setup();
    const { batchId } = batch.executeBatch(sender, dag.selectTips(), {
      transfers: [{ to: r1.address, amount: 100, memo: 'test' }],
    });

    const record = batch.getBatch(batchId);
    assert.ok(record);
    assert.equal(record.sender, sender.address);
    assert.equal(record.transfers[0].memo, 'test');
  });

  it('getBatchesBySender filters correctly', () => {
    const { dag, sender, r1, batch } = setup();
    batch.executeBatch(sender, dag.selectTips(), {
      transfers: [{ to: r1.address, amount: 100 }],
    });
    batch.executeBatch(sender, dag.selectTips(), {
      transfers: [{ to: r1.address, amount: 200 }],
    });

    const batches = batch.getBatchesBySender(sender.address);
    assert.equal(batches.length, 2);
  });

  it('stats are correct', () => {
    const { dag, sender, r1, r2, batch } = setup();
    batch.executeBatch(sender, dag.selectTips(), {
      transfers: [
        { to: r1.address, amount: 100 },
        { to: r2.address, amount: 200 },
      ],
    });

    const stats = batch.getStats();
    assert.equal(stats.totalBatches, 1);
    assert.equal(stats.totalPayments, 2);
    assert.equal(stats.totalTransferred, 300);
  });
});
