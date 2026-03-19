import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Faucet } from '../src/core/faucet.js';
import { DAG } from '../src/core/dag.js';

function createFaucet() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  return { faucet: new Faucet(dag), dag };
}

// Generate a realistic fake embedding (128-dim with proper variance)
function fakeEmbedding(seed = 0) {
  const emb = [];
  for (let i = 0; i < 128; i++) {
    // Simple deterministic pseudo-random based on seed
    emb.push(Math.sin(seed * 1000 + i * 7.3) * 0.3);
  }
  return emb;
}

describe('Faucet.getStatus', () => {
  it('returns correct initial status', () => {
    const { faucet } = createFaucet();
    const status = faucet.getStatus();
    assert.equal(status.totalPool, 600_000_000);
    assert.equal(status.distributed, 0);
    assert.equal(status.remaining, 600_000_000);
    assert.equal(status.recipients, 0);
    assert.equal(status.tokensPerPerson, 1000);
  });
});

describe('Faucet.startVerification', () => {
  it('returns a challenge with instructions', () => {
    const { faucet } = createFaucet();
    const challenge = faucet.startVerification();
    assert.ok(challenge.challengeId);
    assert.ok(challenge.action);
    assert.ok(challenge.instructions);
    assert.equal(challenge.expiresIn, 120);
  });

  it('challenge action is one of the known types', () => {
    const { faucet } = createFaucet();
    const validActions = ['blink', 'smile', 'turn_left', 'turn_right', 'nod'];
    for (let i = 0; i < 20; i++) {
      const challenge = faucet.startVerification();
      assert.ok(validActions.includes(challenge.action));
    }
  });
});

describe('Faucet.claimTokens', () => {
  it('succeeds with valid first claim', async () => {
    const { faucet } = createFaucet();
    const result = await faucet.claimTokens({
      challengeId: 'test-challenge',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });
    assert.ok(result.success);
    assert.equal(result.amount, 1000);
    assert.equal(result.recipientNumber, 1);
  });

  it('rejects failed liveness check', async () => {
    const { faucet } = createFaucet();
    const result = await faucet.claimTokens({
      challengeId: 'test',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: false,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });
    assert.ok(!result.success);
    assert.match(result.error, /[Ll]iveness/);
  });

  it('rejects duplicate IP', async () => {
    const { faucet } = createFaucet();
    await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });

    const result = await faucet.claimTokens({
      challengeId: 'c2',
      faceEmbedding: fakeEmbedding(2),
      livenessPass: true,
      address: 'iotai_bob',
      ip: '1.2.3.4', // same IP
    });
    assert.ok(!result.success);
    assert.match(result.error, /already claimed/i);
  });

  it('rejects duplicate address', async () => {
    const { faucet } = createFaucet();
    await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.1.1.1',
    });

    const result = await faucet.claimTokens({
      challengeId: 'c2',
      faceEmbedding: fakeEmbedding(2),
      livenessPass: true,
      address: 'iotai_alice', // same address
      ip: '2.2.2.2',
    });
    assert.ok(!result.success);
    assert.match(result.error, /already claimed/i);
  });

  it('rejects invalid embedding (too short)', async () => {
    const { faucet } = createFaucet();
    const result = await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: [0.1, 0.2, 0.3],
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });
    assert.ok(!result.success);
    assert.match(result.error, /[Ii]nvalid face/);
  });

  it('rejects fake embedding (low variance)', async () => {
    const { faucet } = createFaucet();
    const result = await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: new Array(128).fill(0.5),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });
    assert.ok(!result.success);
    assert.match(result.error, /fake/i);
  });

  it('rejects similar face (cosine similarity > 0.6)', async () => {
    const { faucet } = createFaucet();
    const emb = fakeEmbedding(42);

    await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: emb,
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.1.1.1',
    });

    // Slightly perturbed version of the same embedding
    const similar = emb.map((v, i) => v + (i % 3 === 0 ? 0.01 : 0));

    const result = await faucet.claimTokens({
      challengeId: 'c2',
      faceEmbedding: similar,
      livenessPass: true,
      address: 'iotai_bob',
      ip: '2.2.2.2',
    });
    assert.ok(!result.success);
    assert.match(result.error, /similar/i);
  });

  it('updates balances after successful claim', async () => {
    const { faucet, dag } = createFaucet();
    const before = dag.getBalance('iotai_genesis');

    await faucet.claimTokens({
      challengeId: 'c1',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });

    assert.equal(dag.getBalance('iotai_alice'), 1000);
    assert.equal(dag.getBalance('iotai_genesis'), before - 1000);
  });
});

describe('Faucet.exportState / importState', () => {
  it('round-trips faucet state', async () => {
    const { faucet: f1, dag: dag1 } = createFaucet();
    await f1.claimTokens({
      challengeId: 'c1',
      faceEmbedding: fakeEmbedding(1),
      livenessPass: true,
      address: 'iotai_alice',
      ip: '1.2.3.4',
    });

    const state = f1.exportState();

    const dag2 = new DAG();
    dag2.initialize(1_000_000_000);
    const f2 = new Faucet(dag2);
    f2.importState(state);

    assert.equal(f2.totalRecipients, 1);
    assert.equal(f2.tokensDistributed, 1000);
    assert.ok(f2.claimedAddresses.has('iotai_alice'));
    assert.equal(f2.faceHashes.size, 1);
    assert.equal(f2.storedEmbeddings.length, 1);
  });
});
