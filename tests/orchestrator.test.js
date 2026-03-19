import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const master = new Wallet({ passphrase: 'master-agent-test' });
  const workerA = new Wallet({ passphrase: 'worker-a-test' });
  const workerB = new Wallet({ passphrase: 'worker-b-test' });
  dag.balances.set(master.address, 100_000);
  dag.balances.set(workerA.address, 5_000);
  dag.balances.set(workerB.address, 5_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 110_000);
  const orchestrator = new Orchestrator({ dag });
  return { dag, master, workerA, workerB, orchestrator };
}

describe('Orchestrator - Pipeline Creation', () => {
  it('creates a pipeline and locks budget', () => {
    const { dag, master, orchestrator } = setup();
    const tips = dag.selectTips();
    const result = orchestrator.createPipeline(master, tips, {
      name: 'Test Pipeline',
      budget: 1000,
      tasks: [
        { name: 'scrape', capability: 'web-scraping', reward: 400 },
        { name: 'analyze', capability: 'data-analysis', reward: 600, dependsOn: ['scrape'] },
      ],
    });

    assert.ok(result.pipelineId);
    assert.equal(result.tasksCount, 2);

    const pipeline = orchestrator.getPipeline(result.pipelineId);
    assert.equal(pipeline.status, 'active');
    assert.equal(pipeline.tasks[0].status, 'available'); // no deps
    assert.equal(pipeline.tasks[1].status, 'pending');   // depends on scrape
  });

  it('rejects if rewards exceed budget', () => {
    const { dag, master, orchestrator } = setup();
    const tips = dag.selectTips();
    assert.throws(() => {
      orchestrator.createPipeline(master, tips, {
        name: 'Over budget',
        budget: 100,
        tasks: [
          { name: 'a', reward: 200 },
        ],
      });
    }, /exceed budget/);
  });

  it('rejects unknown dependencies', () => {
    const { dag, master, orchestrator } = setup();
    const tips = dag.selectTips();
    assert.throws(() => {
      orchestrator.createPipeline(master, tips, {
        name: 'Bad deps',
        budget: 1000,
        tasks: [
          { name: 'a', reward: 100, dependsOn: ['nonexistent'] },
        ],
      });
    }, /Unknown dependency/);
  });

  it('rejects if insufficient balance', () => {
    const { dag, orchestrator } = setup();
    const poor = new Wallet({ passphrase: 'poor-master' });
    dag.balances.set(poor.address, 10);
    const tips = dag.selectTips();
    assert.throws(() => {
      orchestrator.createPipeline(poor, tips, {
        name: 'Expensive',
        budget: 5000,
        tasks: [{ name: 'a', reward: 5000 }],
      });
    }, /Insufficient balance/);
  });
});

describe('Orchestrator - Worker Registration', () => {
  it('registers a worker', () => {
    const { dag, workerA, orchestrator } = setup();
    const tips = dag.selectTips();
    const result = orchestrator.registerWorker(workerA, tips, {
      capabilities: ['web-scraping', 'data-analysis'],
      name: 'Scraper Bot',
    });

    assert.ok(result.txId);
    assert.equal(result.worker.name, 'Scraper Bot');
    assert.deepEqual(result.worker.capabilities, ['web-scraping', 'data-analysis']);
  });

  it('rejects empty capabilities', () => {
    const { dag, workerA, orchestrator } = setup();
    const tips = dag.selectTips();
    assert.throws(() => {
      orchestrator.registerWorker(workerA, tips, { capabilities: [] });
    }, /At least one capability/);
  });
});

describe('Orchestrator - Task Execution Flow', () => {
  it('full pipeline: claim → submit → auto-approve → pay → unlock deps', () => {
    const { dag, master, workerA, workerB, orchestrator } = setup();

    // Create pipeline
    const tips = dag.selectTips();
    const { pipelineId } = orchestrator.createPipeline(master, tips, {
      name: 'Full Flow',
      budget: 1000,
      tasks: [
        { name: 'step1', capability: 'scraping', reward: 400 },
        { name: 'step2', capability: 'analysis', reward: 600, dependsOn: ['step1'] },
      ],
      autoApprove: true,
    });

    // Register workers
    orchestrator.registerWorker(workerA, dag.selectTips(), { capabilities: ['scraping'] });
    orchestrator.registerWorker(workerB, dag.selectTips(), { capabilities: ['analysis'] });

    // Worker A claims step1
    const workerABalBefore = dag.getBalance(workerA.address);
    const claim = orchestrator.claimTask(workerA, dag.selectTips(), { pipelineId, taskIndex: 0 });
    assert.ok(claim.deadline);

    // Worker A submits result (auto-approved)
    const submit = orchestrator.submitResult(workerA, dag.selectTips(), {
      pipelineId,
      taskIndex: 0,
      result: { data: [1, 2, 3] },
    });
    assert.equal(submit.autoApproved, true);

    // Worker A got paid
    assert.equal(dag.getBalance(workerA.address), workerABalBefore + 400);

    // Step 2 should now be available
    const pipeline = orchestrator.getPipeline(pipelineId);
    assert.equal(pipeline.tasks[1].status, 'available');

    // Worker B claims and completes step 2
    const workerBBalBefore = dag.getBalance(workerB.address);
    orchestrator.claimTask(workerB, dag.selectTips(), { pipelineId, taskIndex: 1 });
    orchestrator.submitResult(workerB, dag.selectTips(), {
      pipelineId, taskIndex: 1, result: { report: 'done' },
    });

    assert.equal(dag.getBalance(workerB.address), workerBBalBefore + 600);

    // Pipeline should be completed
    const finalPipeline = orchestrator.getPipeline(pipelineId);
    assert.equal(finalPipeline.status, 'completed');
    assert.equal(finalPipeline.progress.percent, 100);
  });

  it('cannot claim a pending task (deps not met)', () => {
    const { dag, master, workerA, orchestrator } = setup();
    const { pipelineId } = orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Deps',
      budget: 500,
      tasks: [
        { name: 'first', reward: 200 },
        { name: 'second', reward: 300, dependsOn: ['first'] },
      ],
    });

    orchestrator.registerWorker(workerA, dag.selectTips(), { capabilities: ['general'] });

    assert.throws(() => {
      orchestrator.claimTask(workerA, dag.selectTips(), { pipelineId, taskIndex: 1 });
    }, /not available/);
  });

  it('only assigned worker can submit', () => {
    const { dag, master, workerA, workerB, orchestrator } = setup();
    const { pipelineId } = orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Auth test',
      budget: 500,
      tasks: [{ name: 'task1', reward: 500 }],
    });

    orchestrator.registerWorker(workerA, dag.selectTips(), { capabilities: ['general'] });
    orchestrator.registerWorker(workerB, dag.selectTips(), { capabilities: ['general'] });

    orchestrator.claimTask(workerA, dag.selectTips(), { pipelineId, taskIndex: 0 });

    assert.throws(() => {
      orchestrator.submitResult(workerB, dag.selectTips(), {
        pipelineId, taskIndex: 0, result: 'stolen',
      });
    }, /Not the assigned worker/);
  });
});

describe('Orchestrator - Manual Approval', () => {
  it('master can approve/reject submitted tasks', () => {
    const { dag, master, workerA, orchestrator } = setup();
    const { pipelineId } = orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Manual',
      budget: 500,
      tasks: [{ name: 'task1', reward: 500 }],
      autoApprove: false,
    });

    orchestrator.registerWorker(workerA, dag.selectTips(), { capabilities: ['general'] });
    orchestrator.claimTask(workerA, dag.selectTips(), { pipelineId, taskIndex: 0 });
    orchestrator.submitResult(workerA, dag.selectTips(), {
      pipelineId, taskIndex: 0, result: 'bad work',
    });

    // Reject
    const reject = orchestrator.rejectTask(master, { pipelineId, taskIndex: 0, reason: 'Low quality' });
    assert.equal(reject.status, 'available'); // reopened

    // Re-claim and submit better work
    orchestrator.claimTask(workerA, dag.selectTips(), { pipelineId, taskIndex: 0 });
    orchestrator.submitResult(workerA, dag.selectTips(), {
      pipelineId, taskIndex: 0, result: 'good work',
    });

    const approve = orchestrator.approveTask(master, { pipelineId, taskIndex: 0 });
    assert.equal(approve.status, 'approved');
    assert.equal(approve.paid, 500);
  });
});

describe('Orchestrator - Cancel & Stats', () => {
  it('cancel refunds remaining budget', () => {
    const { dag, master, orchestrator } = setup();
    const balBefore = dag.getBalance(master.address);
    const { pipelineId } = orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Cancel me',
      budget: 2000,
      tasks: [{ name: 'a', reward: 2000 }],
    });

    const result = orchestrator.cancelPipeline(master, pipelineId);
    assert.equal(result.status, 'cancelled');
    assert.ok(result.refunded > 0);
  });

  it('returns correct stats', () => {
    const { dag, master, orchestrator } = setup();
    orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Stats test',
      budget: 100,
      tasks: [{ name: 'a', reward: 100 }],
    });

    const stats = orchestrator.getStats();
    assert.equal(stats.totalPipelines, 1);
    assert.equal(stats.activePipelines, 1);
    assert.equal(stats.totalTasks, 1);
  });

  it('getAvailableTasks matches worker capabilities', () => {
    const { dag, master, workerA, orchestrator } = setup();
    orchestrator.createPipeline(master, dag.selectTips(), {
      name: 'Match test',
      budget: 500,
      tasks: [
        { name: 'scrape', capability: 'web-scraping', reward: 200 },
        { name: 'code', capability: 'coding', reward: 300 },
      ],
    });

    orchestrator.registerWorker(workerA, dag.selectTips(), { capabilities: ['web-scraping'] });
    const available = orchestrator.getAvailableTasks(workerA.address);
    assert.equal(available.length, 1);
    assert.equal(available[0].taskName, 'scrape');
  });
});
