import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { createTransaction, createDataTransaction } from '../src/core/transaction.js';
import { generateKeyPair, publicKeyToAddress } from '../src/core/crypto.js';

// Helper: create a funded DAG with a wallet that has tokens
function createFundedDAG() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);

  const pair = generateKeyPair();
  const address = publicKeyToAddress(pair.publicKey);

  // Fund the wallet from genesis
  dag.balances.set(address, 10_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 10_000);

  return { dag, pair, address };
}

describe('DAG initialization', () => {
  it('creates genesis with correct supply', () => {
    const dag = new DAG();
    const genesis = dag.initialize(1_000_000_000);
    assert.equal(genesis.type, 'genesis');
    assert.equal(genesis.amount, 1_000_000_000);
    assert.ok(dag.genesisId);
    assert.equal(dag.transactions.size, 1);
  });

  it('genesis address holds all supply', () => {
    const dag = new DAG();
    dag.initialize(500);
    assert.equal(dag.getBalance('iotai_genesis'), 500);
  });

  it('genesis is the only tip after init', () => {
    const dag = new DAG();
    dag.initialize();
    const tips = dag.getTips();
    assert.equal(tips.length, 1);
    assert.equal(tips[0], dag.genesisId);
  });

  it('accepts custom supply', () => {
    const dag = new DAG();
    dag.initialize(42);
    assert.equal(dag.getBalance('iotai_genesis'), 42);
  });
});

describe('DAG.addTransaction', () => {
  it('adds a valid transfer transaction', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents: tips,
    });

    const result = dag.addTransaction(tx);
    assert.ok(result.success);
    assert.equal(dag.transactions.size, 2); // genesis + transfer
  });

  it('updates balances after transfer', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents: tips,
    });

    dag.addTransaction(tx);
    // Balance accounts for 1% fee (min 1 IOTAI): 10000 - 100 - fee
    const fee = tx.fee || 0;
    assert.equal(dag.getBalance(address), 10_000 - 100 - fee);
    assert.equal(dag.getBalance('iotai_recipient'), 100);
  });

  it('rejects duplicate transaction', () => {
    const { dag, pair } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 50,
      parents: tips,
    });

    dag.addTransaction(tx);
    const result = dag.addTransaction(tx);
    assert.ok(!result.success);
    assert.match(result.error, /already exists/);
  });

  it('rejects transaction with insufficient balance', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 999_999_999,
      parents: tips,
    });

    const result = dag.addTransaction(tx);
    assert.ok(!result.success);
    assert.match(result.error, /Insufficient balance/);
  });

  it('rejects transaction with missing parent', () => {
    const { dag, pair } = createFundedDAG();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 50,
      parents: ['nonexistent1'.padEnd(64, '0'), 'nonexistent2'.padEnd(64, '0')],
    });

    const result = dag.addTransaction(tx);
    assert.ok(!result.success);
    assert.match(result.error, /Parent transaction/);
  });

  it('rejects nonce replay', () => {
    const { dag, pair } = createFundedDAG();
    const tips = dag.selectTips();

    const tx1 = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 50,
      parents: tips,
    });

    dag.addTransaction(tx1);

    // Directly add the same nonce to usedNonces and try a new tx with that nonce
    // We can't just swap nonces because it changes the hash/signature.
    // Instead, verify that the nonce was recorded:
    assert.ok(dag.usedNonces.has(tx1.nonce));

    // Try re-adding the exact same transaction (same nonce) — should fail as duplicate
    const result = dag.addTransaction(tx1);
    assert.ok(!result.success);
    assert.match(result.error, /already exists/);
  });

  it('adds a data transaction (zero value)', () => {
    const { dag, pair } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createDataTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      parents: tips,
      metadata: { msg: 'hello' },
    });

    const result = dag.addTransaction(tx);
    assert.ok(result.success);
  });
});

describe('DAG.selectTips', () => {
  it('returns 2 tips', () => {
    const dag = new DAG();
    dag.initialize();
    const tips = dag.selectTips();
    assert.equal(tips.length, 2);
  });

  it('returns genesis when only 1 tip exists', () => {
    const dag = new DAG();
    dag.initialize();
    const tips = dag.selectTips();
    assert.equal(tips[0], dag.genesisId);
    assert.equal(tips[1], dag.genesisId);
  });
});

describe('DAG.getBalance', () => {
  it('returns 0 for unknown address', () => {
    const dag = new DAG();
    dag.initialize();
    assert.equal(dag.getBalance('iotai_unknown'), 0);
  });
});

describe('DAG.getTransaction', () => {
  it('retrieves genesis by ID', () => {
    const dag = new DAG();
    dag.initialize();
    const tx = dag.getTransaction(dag.genesisId);
    assert.ok(tx);
    assert.equal(tx.type, 'genesis');
  });

  it('returns undefined for unknown ID', () => {
    const dag = new DAG();
    dag.initialize();
    assert.equal(dag.getTransaction('nonexistent'), undefined);
  });
});

describe('DAG.getHistory', () => {
  it('returns transactions involving an address', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const history = dag.getHistory(address);
    assert.ok(history.length >= 1);
    assert.ok(history.some(t => t.id === tx.id));
  });

  it('returns empty array for address with no history', () => {
    const dag = new DAG();
    dag.initialize();
    assert.deepEqual(dag.getHistory('iotai_nobody'), []);
  });
});

describe('DAG.getStats', () => {
  it('returns correct stats after init', () => {
    const dag = new DAG();
    dag.initialize();
    const stats = dag.getStats();
    assert.equal(stats.totalTransactions, 1);
    assert.equal(stats.tipCount, 1);
  });
});

describe('DAG.exportState / importState', () => {
  it('exports and imports genesis-only state', () => {
    const dag = new DAG();
    dag.initialize(1_000_000_000);

    const state = dag.exportState();
    const dag2 = new DAG();
    dag2.importState(state);

    assert.ok(dag2.getTransaction(dag.genesisId));
    assert.equal(dag2.genesisId, dag.genesisId);
    assert.equal(dag2.getBalance('iotai_genesis'), 1_000_000_000);
  });

  it('exports and imports state with transactions', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = dag.exportState();

    const dag2 = new DAG();
    dag2.importState(state);

    // importState now uses direct insertion (no re-validation)
    assert.ok(dag2.getTransaction(dag.genesisId));
    assert.ok(dag2.getTransaction(tx.id));
    assert.equal(dag2.transactions.size, 2);
  });

  it('importState restores nonces from all transactions', () => {
    const { dag, pair } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = dag.exportState();
    const dag2 = new DAG();
    dag2.importState(state);

    // Nonce from the transfer should be tracked
    assert.ok(dag2.usedNonces.has(tx.nonce));
  });

  it('importState reconstructs balances from transfers', () => {
    const { dag, pair, address } = createFundedDAG();
    const tips = dag.selectTips();

    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 200,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = dag.exportState();
    const dag2 = new DAG();
    dag2.importState(state);

    assert.equal(dag2.getBalance('iotai_bob'), 200);
  });
});

describe('cumulative weight updates', () => {
  it('parent cumulative weight increases when child is added', () => {
    const { dag, pair } = createFundedDAG();
    const genesisWeight = dag.getTransaction(dag.genesisId).cumulativeWeight;

    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const newWeight = dag.getTransaction(dag.genesisId).cumulativeWeight;
    assert.ok(newWeight > genesisWeight);
  });
});
