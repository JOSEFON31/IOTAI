import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_ID,
  createGenesis,
  createTransaction,
  createDataTransaction,
  verifyTransaction,
  serializeTransaction,
  deserializeTransaction,
} from '../src/core/transaction.js';
import { generateKeyPair, publicKeyToAddress, sign } from '../src/core/crypto.js';

describe('GENESIS_ID', () => {
  it('is 64 zeros', () => {
    assert.equal(GENESIS_ID, '0'.repeat(64));
  });
});

describe('createGenesis', () => {
  it('creates a genesis transaction with correct fields', () => {
    const tx = createGenesis(1_000_000_000);
    assert.equal(tx.type, 'genesis');
    assert.equal(tx.from, 'iotai_genesis');
    assert.equal(tx.to, 'iotai_genesis');
    assert.equal(tx.amount, 1_000_000_000);
    assert.deepEqual(tx.parents, []);
    assert.equal(tx.weight, 1);
    assert.equal(tx.cumulativeWeight, 1);
    assert.ok(tx.id);
    assert.ok(tx.nonce);
    assert.ok(tx.timestamp);
  });

  it('different calls produce different IDs (different timestamps/nonces)', () => {
    const a = createGenesis(100);
    const b = createGenesis(100);
    assert.notEqual(a.id, b.id);
  });
});

describe('createTransaction', () => {
  const pair = generateKeyPair();
  const parents = ['a'.repeat(64), 'b'.repeat(64)];

  it('creates a valid transfer transaction', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 500,
      parents,
    });

    assert.equal(tx.type, 'transfer');
    assert.equal(tx.from, publicKeyToAddress(pair.publicKey));
    assert.equal(tx.to, 'iotai_recipient');
    assert.equal(tx.amount, 500);
    assert.equal(tx.parents.length, 2);
    assert.ok(tx.signature);
    assert.ok(tx.id);
    assert.ok(tx.nonce);
  });

  it('throws if parents length is not 2', () => {
    assert.throws(() => {
      createTransaction({
        senderSecretKey: pair.secretKey,
        senderPublicKey: pair.publicKey,
        to: 'iotai_recipient',
        amount: 100,
        parents: ['only_one'],
      });
    }, /exactly 2 parent/);
  });

  it('throws if amount is zero or negative', () => {
    assert.throws(() => {
      createTransaction({
        senderSecretKey: pair.secretKey,
        senderPublicKey: pair.publicKey,
        to: 'iotai_recipient',
        amount: 0,
        parents,
      });
    }, /Amount must be positive/);

    assert.throws(() => {
      createTransaction({
        senderSecretKey: pair.secretKey,
        senderPublicKey: pair.publicKey,
        to: 'iotai_recipient',
        amount: -10,
        parents,
      });
    }, /Amount must be positive/);
  });

  it('sorts parents canonically', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents: ['z'.repeat(64), 'a'.repeat(64)],
    });
    assert.equal(tx.parents[0], 'a'.repeat(64));
    assert.equal(tx.parents[1], 'z'.repeat(64));
  });

  it('includes metadata when provided', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
      metadata: { note: 'payment' },
    });
    assert.deepEqual(tx.metadata, { note: 'payment' });
  });
});

describe('createDataTransaction', () => {
  const pair = generateKeyPair();
  const parents = ['a'.repeat(64), 'b'.repeat(64)];

  it('creates a data transaction with zero value', () => {
    const tx = createDataTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      parents,
      metadata: { message: 'hello DAG' },
    });

    assert.equal(tx.type, 'data');
    assert.equal(tx.amount, 0);
    assert.equal(tx.from, tx.to); // data tx sends to self
    assert.deepEqual(tx.metadata, { message: 'hello DAG' });
  });

  it('throws if parents length is not 2', () => {
    assert.throws(() => {
      createDataTransaction({
        senderSecretKey: pair.secretKey,
        senderPublicKey: pair.publicKey,
        parents: [],
        metadata: { x: 1 },
      });
    }, /exactly 2 parent/);
  });
});

describe('verifyTransaction', () => {
  const pair = generateKeyPair();
  const parents = ['a'.repeat(64), 'b'.repeat(64)];

  it('verifies a valid transfer transaction', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
    });
    const result = verifyTransaction(tx);
    assert.ok(result.valid);
  });

  it('verifies a genesis transaction', () => {
    const tx = createGenesis(1_000_000_000);
    assert.ok(verifyTransaction(tx).valid);
  });

  it('verifies a data transaction', () => {
    const tx = createDataTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      parents,
      metadata: { data: true },
    });
    assert.ok(verifyTransaction(tx).valid);
  });

  it('rejects tampered amount', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
    });
    tx.amount = 999999;
    const result = verifyTransaction(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /hash mismatch/i);
  });

  it('rejects tampered signature', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
    });
    // Sign with a different key to produce a valid base64 signature that won't verify
    const otherPair = generateKeyPair();
    tx.signature = sign(tx.id, otherPair.secretKey);
    const result = verifyTransaction(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /[Ii]nvalid signature/);
  });

  it('rejects wrong sender public key', async () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
    });
    const other = generateKeyPair();
    const { encodePublicKey } = await import('../src/core/crypto.js');
    tx.senderPublicKey = encodePublicKey(other.publicKey);
    const result = verifyTransaction(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /does not match/i);
  });

  it('rejects missing parents on non-genesis', () => {
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 100,
      parents,
    });
    tx.parents = [];
    const result = verifyTransaction(tx);
    assert.ok(!result.valid);
    assert.match(result.error, /2 parents/);
  });
});

describe('serializeTransaction / deserializeTransaction', () => {
  it('round-trips a transaction', () => {
    const pair = generateKeyPair();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_recipient',
      amount: 42,
      parents: ['a'.repeat(64), 'b'.repeat(64)],
    });
    const json = serializeTransaction(tx);
    const restored = deserializeTransaction(json);
    assert.equal(restored.id, tx.id);
    assert.equal(restored.amount, tx.amount);
    assert.equal(restored.signature, tx.signature);
  });
});
