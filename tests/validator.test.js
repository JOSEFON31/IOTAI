import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '../src/consensus/validator.js';
import { DAG } from '../src/core/dag.js';
import { createTransaction } from '../src/core/transaction.js';
import { generateKeyPair, publicKeyToAddress } from '../src/core/crypto.js';

// Minimal mock node
function createMockNode(peerCount = 2) {
  return {
    hasMinimumPeers: () => peerCount >= 2,
  };
}

function setup(peerCount = 2) {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const node = createMockNode(peerCount);
  const validator = new Validator(dag, node);

  const pair = generateKeyPair();
  const address = publicKeyToAddress(pair.publicKey);
  dag.balances.set(address, 10_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 10_000);

  return { dag, validator, pair, address };
}

describe('Validator.validate', () => {
  it('accepts a valid transaction with sufficient peers', () => {
    const { dag, validator, pair } = setup(2);
    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: tips,
    });

    const result = validator.validate(tx);
    assert.ok(result.valid);
  });

  it('rejects when fewer than 2 peers', () => {
    const { dag, validator, pair } = setup(1);
    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: tips,
    });

    const result = validator.validate(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /minimum 2/i);
  });

  it('rejects transaction with future timestamp', () => {
    const { dag, validator, pair } = setup();
    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: tips,
    });
    // Set timestamp 10 minutes in the future
    tx.timestamp = Date.now() + 10 * 60 * 1000;

    const result = validator.validate(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /future/i);
  });

  it('rejects transaction with non-existent parent', () => {
    const { validator, pair } = setup();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: ['fake1'.padEnd(64, '0'), 'fake2'.padEnd(64, '0')],
    });

    const result = validator.validate(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /not found/);
  });
});

describe('Validator.isConfirmed', () => {
  it('returns false for unconfirmed transaction', () => {
    const { dag, validator, pair } = setup();
    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    assert.ok(!validator.isConfirmed(tx.id));
  });

  it('returns false for nonexistent transaction', () => {
    const { validator } = setup();
    assert.ok(!validator.isConfirmed('nonexistent'));
  });
});

describe('Validator.getConfirmationStatus', () => {
  it('returns correct status for unconfirmed tx', () => {
    const { dag, validator, pair } = setup();
    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const status = validator.getConfirmationStatus(tx.id);
    assert.equal(status.confirmed, false);
    assert.equal(status.threshold, 5);
    assert.ok(status.confidence >= 0 && status.confidence <= 1);
  });

  it('returns zero-state for unknown tx', () => {
    const { validator } = setup();
    const status = validator.getConfirmationStatus('unknown');
    assert.equal(status.confirmed, false);
    assert.equal(status.weight, 0);
    assert.equal(status.confidence, 0);
  });
});

describe('Validator.resolveConflict', () => {
  it('picks higher cumulative weight', () => {
    const { dag, validator, pair } = setup();
    const tips = dag.selectTips();

    const tx1 = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx1);

    const tx2 = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_carol',
      amount: 50,
      parents: dag.selectTips(),
    });
    dag.addTransaction(tx2);

    // tx1 should have higher weight because tx2 references it (indirectly through tip selection)
    // But both might have weight 1. Force different weights for test:
    dag.getTransaction(tx1.id).cumulativeWeight = 10;
    dag.getTransaction(tx2.id).cumulativeWeight = 3;

    const winner = validator.resolveConflict(tx1.id, tx2.id);
    assert.equal(winner, tx1.id);
  });

  it('uses timestamp as tiebreaker', () => {
    const { dag, validator, pair } = setup();
    const tips = dag.selectTips();

    const tx1 = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx1);

    const tx2 = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_carol',
      amount: 50,
      parents: dag.selectTips(),
    });
    dag.addTransaction(tx2);

    // Same weight, different timestamps
    dag.getTransaction(tx1.id).cumulativeWeight = 5;
    dag.getTransaction(tx2.id).cumulativeWeight = 5;
    dag.getTransaction(tx1.id).timestamp = 1000;
    dag.getTransaction(tx2.id).timestamp = 2000;

    const winner = validator.resolveConflict(tx1.id, tx2.id);
    assert.equal(winner, tx1.id); // earlier timestamp wins
  });

  it('returns other ID if one tx does not exist', () => {
    const { validator } = setup();
    assert.equal(validator.resolveConflict('nonexistent', 'also_none'), 'also_none');
  });
});
