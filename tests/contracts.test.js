import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { ContractEngine } from '../src/contracts/engine.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const owner = new Wallet({ passphrase: 'contract-owner-test' });
  const worker = new Wallet({ passphrase: 'contract-worker-test' });
  dag.balances.set(owner.address, 100_000);
  dag.balances.set(worker.address, 10_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 110_000);
  const contracts = new ContractEngine({ dag });
  return { dag, owner, worker, contracts };
}

describe('Smart Contracts - Deploy', () => {
  it('deploys a contract and locks budget', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    const result = contracts.deploy(owner, tips, {
      name: 'Test Contract',
      conditions: [{ field: 'metadata.type', operator: '==', value: 'test' }],
      actions: [{ type: 'transfer', to: 'iotai_someone', amount: 100 }],
      maxExecutions: 3,
    });

    assert.ok(result.contractId);
    assert.ok(result.txId);
    assert.equal(result.budget, 300); // 100 * 3

    const contract = contracts.getContract(result.contractId);
    assert.equal(contract.status, 'active');
    assert.equal(contract.maxExecutions, 3);
    assert.equal(contract.executionCount, 0);
  });

  it('rejects deploy without conditions', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    assert.throws(() => {
      contracts.deploy(owner, tips, {
        name: 'Bad',
        conditions: [],
        actions: [{ type: 'transfer', to: 'x', amount: 10 }],
      });
    }, /At least one condition/);
  });

  it('rejects deploy with insufficient balance', () => {
    const { dag, contracts } = setup();
    const poor = new Wallet({ passphrase: 'poor-agent' });
    dag.balances.set(poor.address, 5);
    const tips = dag.selectTips();
    assert.throws(() => {
      contracts.deploy(poor, tips, {
        name: 'Expensive',
        conditions: [{ field: 'type', operator: '==', value: 'x' }],
        actions: [{ type: 'transfer', to: 'x', amount: 1000 }],
        maxExecutions: 10,
      });
    }, /Insufficient balance/);
  });

  it('rejects invalid operator', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    assert.throws(() => {
      contracts.deploy(owner, tips, {
        name: 'Bad Op',
        conditions: [{ field: 'x', operator: 'LIKE', value: 'y' }],
        actions: [{ type: 'notify' }],
      });
    }, /Invalid operator/);
  });
});

describe('Smart Contracts - Evaluate', () => {
  it('triggers transfer when conditions match', () => {
    const { dag, owner, worker, contracts } = setup();
    const tips = dag.selectTips();
    const { contractId } = contracts.deploy(owner, tips, {
      name: 'Pay on match',
      conditions: [
        { field: 'metadata.type', operator: '==', value: 'result' },
        { field: 'metadata.score', operator: '>=', value: 90 },
      ],
      actions: [{ type: 'transfer', to: worker.address, amount: 500 }],
      maxExecutions: 2,
    });

    const workerBalBefore = dag.getBalance(worker.address);

    // Create a matching data tx
    const tips2 = dag.selectTips();
    const tx = owner.sendData(tips2, { type: 'result', score: 95 });
    dag.addTransaction(tx);

    const triggered = contracts.evaluate(tx);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].results[0].success, true);
    assert.equal(triggered[0].results[0].amount, 500);

    assert.equal(dag.getBalance(worker.address), workerBalBefore + 500);

    const contract = contracts.getContract(contractId);
    assert.equal(contract.executionCount, 1);
  });

  it('does NOT trigger when conditions do not match', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    contracts.deploy(owner, tips, {
      name: 'No match',
      conditions: [{ field: 'metadata.type', operator: '==', value: 'special' }],
      actions: [{ type: 'transfer', to: 'x', amount: 10 }],
    });

    const tips2 = dag.selectTips();
    const tx = owner.sendData(tips2, { type: 'normal' });
    dag.addTransaction(tx);

    const triggered = contracts.evaluate(tx);
    assert.equal(triggered.length, 0);
  });

  it('completes after maxExecutions reached', () => {
    const { dag, owner, worker, contracts } = setup();
    const tips = dag.selectTips();
    const { contractId } = contracts.deploy(owner, tips, {
      name: 'Once only',
      conditions: [{ field: 'metadata.ping', operator: '==', value: true }],
      actions: [{ type: 'transfer', to: worker.address, amount: 50 }],
      maxExecutions: 1,
    });

    // First trigger
    const tx1 = owner.sendData(dag.selectTips(), { ping: true });
    dag.addTransaction(tx1);
    contracts.evaluate(tx1);

    // Second trigger should not fire
    const tx2 = owner.sendData(dag.selectTips(), { ping: true });
    dag.addTransaction(tx2);
    const triggered2 = contracts.evaluate(tx2);
    assert.equal(triggered2.length, 0);

    assert.equal(contracts.getContract(contractId).status, 'completed');
  });

  it('supports contains operator', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    contracts.deploy(owner, tips, {
      name: 'Contains test',
      conditions: [{ field: 'metadata.tags', operator: 'contains', value: 'urgent' }],
      actions: [{ type: 'notify', message: 'found' }],
    });

    const tx = owner.sendData(dag.selectTips(), { tags: ['normal', 'urgent', 'ai'] });
    dag.addTransaction(tx);
    const triggered = contracts.evaluate(tx);
    assert.equal(triggered.length, 1);
  });

  it('supports exists operator', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    contracts.deploy(owner, tips, {
      name: 'Exists test',
      conditions: [{ field: 'metadata.secret', operator: 'exists', value: true }],
      actions: [{ type: 'notify' }],
    });

    const tx1 = owner.sendData(dag.selectTips(), { secret: 'abc' });
    dag.addTransaction(tx1);
    assert.equal(contracts.evaluate(tx1).length, 1);
  });
});

describe('Smart Contracts - Lifecycle', () => {
  it('pause and resume', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    const { contractId } = contracts.deploy(owner, tips, {
      name: 'Pausable',
      conditions: [{ field: 'metadata.x', operator: '==', value: 1 }],
      actions: [{ type: 'notify' }],
    });

    contracts.pause(owner, contractId);
    assert.equal(contracts.getContract(contractId).status, 'paused');

    // Should not trigger while paused
    const tx = owner.sendData(dag.selectTips(), { x: 1 });
    dag.addTransaction(tx);
    assert.equal(contracts.evaluate(tx).length, 0);

    contracts.resume(owner, contractId);
    assert.equal(contracts.getContract(contractId).status, 'active');
  });

  it('cancel refunds remaining budget', () => {
    const { dag, owner, contracts } = setup();
    const balBefore = dag.getBalance(owner.address);
    const tips = dag.selectTips();
    const { contractId, budget } = contracts.deploy(owner, tips, {
      name: 'Cancel me',
      conditions: [{ field: 'type', operator: '==', value: 'x' }],
      actions: [{ type: 'transfer', to: 'someone', amount: 200 }],
      maxExecutions: 5,
    });

    const balAfter = dag.getBalance(owner.address);
    assert.ok(balAfter < balBefore); // budget was locked

    const result = contracts.cancel(owner, contractId);
    assert.equal(result.status, 'cancelled');
    assert.equal(contracts.getContract(contractId).status, 'cancelled');
  });

  it('only owner can pause/cancel', () => {
    const { dag, owner, worker, contracts } = setup();
    const tips = dag.selectTips();
    const { contractId } = contracts.deploy(owner, tips, {
      name: 'Owned',
      conditions: [{ field: 'x', operator: '==', value: 1 }],
      actions: [{ type: 'notify' }],
    });

    assert.throws(() => contracts.pause(worker, contractId), /Only owner/);
    assert.throws(() => contracts.cancel(worker, contractId), /Only owner/);
  });
});

describe('Smart Contracts - Stats', () => {
  it('returns correct stats', () => {
    const { dag, owner, contracts } = setup();
    const tips = dag.selectTips();
    contracts.deploy(owner, tips, {
      name: 'A',
      conditions: [{ field: 'x', operator: '==', value: 1 }],
      actions: [{ type: 'notify' }],
    });

    const stats = contracts.getStats();
    assert.equal(stats.totalContracts, 1);
    assert.equal(stats.active, 1);
  });
});
