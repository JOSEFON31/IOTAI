import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Faucet } from '../src/core/faucet.js';
import { Storage } from '../src/core/storage.js';
import { createTransaction } from '../src/core/transaction.js';
import { generateKeyPair, publicKeyToAddress } from '../src/core/crypto.js';

function createTestStorage() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const faucet = new Faucet(dag);
  const storage = new Storage({ dag, faucet, autoSaveInterval: 999999 });
  return { dag, faucet, storage };
}

describe('Storage._serializeState / _restoreState', () => {
  it('serializes and restores full state', () => {
    const { dag, faucet, storage } = createTestStorage();

    const pair = generateKeyPair();
    const address = publicKeyToAddress(pair.publicKey);
    dag.balances.set(address, 5000);
    dag.balances.set('iotai_genesis', 1_000_000_000 - 5000);

    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 100,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = storage._serializeState();

    // Restore into fresh DAG
    const dag2 = new DAG();
    const faucet2 = new Faucet(dag2);
    const storage2 = new Storage({ dag: dag2, faucet: faucet2 });

    const ok = storage2._restoreState(state);
    assert.ok(ok);

    assert.equal(dag2.transactions.size, 2);
    assert.ok(dag2.getTransaction(tx.id));
    // Balance accounts for 1% fee (min 1 IOTAI): 5000 - 100 - 1 fee = 4899
    const fee = tx.fee || 0;
    assert.equal(dag2.getBalance(address), 5000 - 100 - fee);
    assert.equal(dag2.getBalance('iotai_bob'), 100);
  });

  it('restores nonces and prevents replay', () => {
    const { dag, storage } = createTestStorage();

    const pair = generateKeyPair();
    const address = publicKeyToAddress(pair.publicKey);
    dag.balances.set(address, 5000);

    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = storage._serializeState();

    // Restore
    const dag2 = new DAG();
    const faucet2 = new Faucet(dag2);
    const storage2 = new Storage({ dag: dag2, faucet: faucet2 });
    storage2._restoreState(state);

    // The tx nonce must be in usedNonces after restore
    assert.ok(dag2.usedNonces.has(tx.nonce));
  });

  it('restores nonces even if state.nonces is missing (legacy format)', () => {
    const { dag, storage } = createTestStorage();

    const pair = generateKeyPair();
    const address = publicKeyToAddress(pair.publicKey);
    dag.balances.set(address, 5000);

    const tips = dag.selectTips();
    const tx = createTransaction({
      senderSecretKey: pair.secretKey,
      senderPublicKey: pair.publicKey,
      to: 'iotai_bob',
      amount: 50,
      parents: tips,
    });
    dag.addTransaction(tx);

    const state = storage._serializeState();
    // Simulate legacy format: remove nonces array
    delete state.nonces;

    const dag2 = new DAG();
    const faucet2 = new Faucet(dag2);
    const storage2 = new Storage({ dag: dag2, faucet: faucet2 });
    storage2._restoreState(state);

    // Nonces should still be recovered from transactions
    assert.ok(dag2.usedNonces.has(tx.nonce));
  });

  it('restores faucet state', async () => {
    const { dag, faucet, storage } = createTestStorage();

    // Simulate a faucet claim
    const emb = Array.from({ length: 128 }, (_, i) => Math.sin(i * 7.3) * 0.3);
    await faucet.claimTokens({
      challengeId: 'test',
      faceEmbedding: emb,
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });

    const state = storage._serializeState();

    const dag2 = new DAG();
    dag2.initialize(1_000_000_000);
    const faucet2 = new Faucet(dag2);
    const storage2 = new Storage({ dag: dag2, faucet: faucet2 });
    storage2._restoreState(state);

    assert.equal(faucet2.totalRecipients, 1);
    assert.equal(faucet2.tokensDistributed, 1000);
    assert.ok(faucet2.claimedAddresses.has('iotai_alice'));
  });

  it('returns false for empty/invalid state', () => {
    const { storage } = createTestStorage();
    assert.ok(!storage._restoreState(null));
    assert.ok(!storage._restoreState({}));
    assert.ok(!storage._restoreState({ transactions: [] }));
  });
});
