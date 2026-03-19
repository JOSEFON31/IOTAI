/**
 * IOTAI Agent Orchestrator
 *
 * Coordinates multi-agent task pipelines. A "master" agent creates a pipeline
 * with ordered tasks, budgets, and dependencies. "Worker" agents claim tasks,
 * execute them, and submit results. Payments are automatic via escrow.
 *
 * Pipeline Flow:
 *   1. Master creates pipeline with tasks + budget
 *   2. Workers register capabilities
 *   3. Workers claim matching tasks
 *   4. Workers submit results
 *   5. Auto-payment on approval (or master reviews)
 *   6. Next dependent tasks unlock
 *
 * Example pipeline:
 *   scrape (200 IOTAI) → analyze (500 IOTAI) → report (300 IOTAI)
 *        ↓                      ↓                     ↓
 *   Worker A claims        Worker B claims         Worker C claims
 *   submits data...        processes data...       generates PDF...
 */

export class Orchestrator {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, Pipeline>} */
    this.pipelines = new Map();

    /** @type {Map<string, Worker>} address -> worker */
    this.workers = new Map();

    /** @type {Map<string, Pipeline[]>} ownerAddress -> pipelines */
    this.pipelinesByOwner = new Map();
  }

  // ============================================================
  // PIPELINE MANAGEMENT
  // ============================================================

  /**
   * Create a new task pipeline
   * @param {Wallet} wallet - Master agent wallet
   * @param {string[]} tips - DAG tips
   * @param {object} params
   * @param {string} params.name - Pipeline name
   * @param {Task[]} params.tasks - Ordered task list
   * @param {number} params.budget - Total IOTAI budget
   * @returns {{ pipelineId: string, txId: string }}
   */
  createPipeline(wallet, tips, { name, tasks, budget, description, autoApprove }) {
    if (!name) throw new Error('Pipeline name is required');
    if (!tasks || tasks.length === 0) throw new Error('At least one task is required');
    if (!budget || budget <= 0) throw new Error('Budget must be > 0');

    // Validate tasks
    const totalReward = tasks.reduce((sum, t) => sum + (t.reward || 0), 0);
    if (totalReward > budget) {
      throw new Error(`Task rewards (${totalReward}) exceed budget (${budget})`);
    }

    // Validate dependencies
    const taskNames = tasks.map(t => t.name);
    for (const task of tasks) {
      if (task.dependsOn) {
        for (const dep of task.dependsOn) {
          if (!taskNames.includes(dep)) throw new Error(`Unknown dependency: ${dep}`);
        }
      }
    }

    // Check balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < budget) {
      throw new Error(`Insufficient balance. Need ${budget}, have ${balance}`);
    }

    const pipelineId = this._generateId('p');

    // Record on DAG
    const tx = wallet.sendData(tips, {
      _orchestrator: 'pipeline',
      pipelineId,
      name,
      description: description || '',
      tasks: tasks.map((t, i) => ({
        index: i,
        name: t.name,
        capability: t.capability || 'general',
        reward: t.reward || 0,
        dependsOn: t.dependsOn || [],
        timeout: t.timeout || 3600000, // 1h default
        description: t.description || '',
      })),
      budget,
      owner: wallet.address,
      autoApprove: autoApprove !== false, // default true
      createdAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Lock budget
    const escrowAddr = `iotai_pipeline_${pipelineId}`;
    const tips2 = this.dag.selectTips();
    const lockTx = wallet.send(escrowAddr, budget, tips2, {
      _orchestrator: 'lock_budget',
      pipelineId,
    });
    const lockResult = this.dag.addTransaction(lockTx);
    if (!lockResult.success) throw new Error(`Budget lock failed: ${lockResult.error}`);

    // Index pipeline
    const pipeline = {
      pipelineId,
      txId: tx.id,
      name,
      description: description || '',
      owner: wallet.address,
      budget,
      remainingBudget: budget,
      autoApprove: autoApprove !== false,
      status: 'active',
      tasks: tasks.map((t, i) => ({
        index: i,
        name: t.name,
        capability: t.capability || 'general',
        reward: t.reward || 0,
        dependsOn: t.dependsOn || [],
        timeout: t.timeout || 3600000,
        description: t.description || '',
        status: 'pending', // pending, available, claimed, submitted, approved, rejected, timeout
        worker: null,
        claimedAt: null,
        submittedAt: null,
        result: null,
      })),
      createdAt: Date.now(),
      completedAt: null,
    };

    // Mark tasks with no dependencies as "available"
    for (const task of pipeline.tasks) {
      if (!task.dependsOn || task.dependsOn.length === 0) {
        task.status = 'available';
      }
    }

    this.pipelines.set(pipelineId, pipeline);
    const ownerPipelines = this.pipelinesByOwner.get(wallet.address) || [];
    ownerPipelines.push(pipeline);
    this.pipelinesByOwner.set(wallet.address, ownerPipelines);

    return { pipelineId, txId: tx.id, budget, tasksCount: tasks.length };
  }

  /**
   * Get pipeline status with full task details
   */
  getPipeline(pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return null;
    return {
      ...pipeline,
      progress: this._calculateProgress(pipeline),
    };
  }

  /**
   * Cancel pipeline and refund remaining budget
   */
  cancelPipeline(wallet, pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.owner !== wallet.address) throw new Error('Only owner can cancel');
    if (pipeline.status !== 'active') throw new Error('Pipeline is not active');

    // Refund remaining budget
    const escrowAddr = `iotai_pipeline_${pipelineId}`;
    const bal = this.dag.getBalance(escrowAddr);
    if (bal > 0) {
      this.dag.balances.set(escrowAddr, 0);
      const ownerBal = this.dag.balances.get(wallet.address) || 0;
      this.dag.balances.set(wallet.address, ownerBal + bal);
    }

    pipeline.status = 'cancelled';
    return { pipelineId, status: 'cancelled', refunded: bal };
  }

  // ============================================================
  // WORKER MANAGEMENT
  // ============================================================

  /**
   * Register as a worker agent
   */
  registerWorker(wallet, tips, { capabilities, name, description }) {
    if (!capabilities || capabilities.length === 0) {
      throw new Error('At least one capability is required');
    }

    // Record on DAG
    const tx = wallet.sendData(tips, {
      _orchestrator: 'worker',
      worker: wallet.address,
      name: name || `Worker-${wallet.address.substring(0, 8)}`,
      capabilities,
      description: description || '',
      registeredAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    const worker = {
      address: wallet.address,
      name: name || `Worker-${wallet.address.substring(0, 8)}`,
      capabilities,
      description: description || '',
      status: 'active',
      tasksCompleted: 0,
      totalEarned: 0,
      registeredAt: Date.now(),
    };

    this.workers.set(wallet.address, worker);
    return { txId: tx.id, worker };
  }

  /**
   * Get available tasks matching worker capabilities
   */
  getAvailableTasks(workerAddress) {
    const worker = this.workers.get(workerAddress);
    if (!worker) return [];

    const available = [];
    for (const [, pipeline] of this.pipelines) {
      if (pipeline.status !== 'active') continue;

      for (const task of pipeline.tasks) {
        if (task.status !== 'available') continue;
        if (worker.capabilities.includes(task.capability) || task.capability === 'general') {
          available.push({
            pipelineId: pipeline.pipelineId,
            pipelineName: pipeline.name,
            taskIndex: task.index,
            taskName: task.name,
            capability: task.capability,
            reward: task.reward,
            description: task.description,
            timeout: task.timeout,
          });
        }
      }
    }

    return available.sort((a, b) => b.reward - a.reward);
  }

  // ============================================================
  // TASK EXECUTION
  // ============================================================

  /**
   * Worker claims a task
   */
  claimTask(wallet, tips, { pipelineId, taskIndex }) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.status !== 'active') throw new Error('Pipeline is not active');

    const task = pipeline.tasks[taskIndex];
    if (!task) throw new Error('Task not found');
    if (task.status !== 'available') throw new Error(`Task is ${task.status}, not available`);

    const worker = this.workers.get(wallet.address);
    if (!worker) throw new Error('Register as worker first');

    // Record claim on DAG
    const tx = wallet.sendData(tips, {
      _orchestrator: 'claim',
      pipelineId,
      taskIndex,
      taskName: task.name,
      worker: wallet.address,
      claimedAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    task.status = 'claimed';
    task.worker = wallet.address;
    task.claimedAt = Date.now();
    task.deadline = Date.now() + task.timeout;

    return { txId: tx.id, task: task.name, deadline: task.deadline };
  }

  /**
   * Worker submits task result
   */
  submitResult(wallet, tips, { pipelineId, taskIndex, result: taskResult }) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');

    const task = pipeline.tasks[taskIndex];
    if (!task) throw new Error('Task not found');
    if (task.status !== 'claimed') throw new Error(`Task is ${task.status}, not claimed`);
    if (task.worker !== wallet.address) throw new Error('Not the assigned worker');

    // Check timeout
    if (task.deadline && Date.now() > task.deadline) {
      task.status = 'timeout';
      task.status = 'available'; // Re-open for other workers
      task.worker = null;
      throw new Error('Task timed out');
    }

    // Record submission on DAG
    const tx = wallet.sendData(tips, {
      _orchestrator: 'submit',
      pipelineId,
      taskIndex,
      taskName: task.name,
      worker: wallet.address,
      resultSummary: typeof taskResult === 'object' ? JSON.stringify(taskResult).substring(0, 200) : String(taskResult).substring(0, 200),
      submittedAt: Date.now(),
    });
    const dagResult = this.dag.addTransaction(tx);
    if (!dagResult.success) throw new Error(dagResult.error);

    task.status = 'submitted';
    task.result = taskResult;
    task.submittedAt = Date.now();

    // Auto-approve if enabled
    if (pipeline.autoApprove) {
      this._approveTask(pipeline, task);
    }

    return { txId: tx.id, status: task.status, autoApproved: pipeline.autoApprove };
  }

  /**
   * Master approves a submitted task (manual mode)
   */
  approveTask(wallet, { pipelineId, taskIndex }) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.owner !== wallet.address) throw new Error('Only pipeline owner can approve');

    const task = pipeline.tasks[taskIndex];
    if (!task) throw new Error('Task not found');
    if (task.status !== 'submitted') throw new Error('Task not submitted');

    this._approveTask(pipeline, task);
    return { pipelineId, taskIndex, status: 'approved', paid: task.reward };
  }

  /**
   * Master rejects a submitted task
   */
  rejectTask(wallet, { pipelineId, taskIndex, reason }) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.owner !== wallet.address) throw new Error('Only pipeline owner can reject');

    const task = pipeline.tasks[taskIndex];
    if (!task) throw new Error('Task not found');
    if (task.status !== 'submitted') throw new Error('Task not submitted');

    task.status = 'available'; // Re-open
    task.worker = null;
    task.result = null;
    task.rejectedReason = reason || '';
    return { pipelineId, taskIndex, status: 'available' };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /** Get pipelines by owner */
  getPipelinesByOwner(address) {
    return (this.pipelinesByOwner.get(address) || []).map(p => ({
      pipelineId: p.pipelineId,
      name: p.name,
      status: p.status,
      budget: p.budget,
      remainingBudget: p.remainingBudget,
      tasksCount: p.tasks.length,
      progress: this._calculateProgress(p),
      createdAt: p.createdAt,
    }));
  }

  /** Get worker info */
  getWorker(address) {
    return this.workers.get(address) || null;
  }

  /** Get all registered workers */
  getWorkers() {
    return [...this.workers.values()];
  }

  /** Get orchestrator stats */
  getStats() {
    const allPipelines = [...this.pipelines.values()];
    let totalTasks = 0;
    let completedTasks = 0;
    let totalPaid = 0;

    for (const p of allPipelines) {
      totalTasks += p.tasks.length;
      for (const t of p.tasks) {
        if (t.status === 'approved') {
          completedTasks++;
          totalPaid += t.reward;
        }
      }
    }

    return {
      totalPipelines: allPipelines.length,
      activePipelines: allPipelines.filter(p => p.status === 'active').length,
      completedPipelines: allPipelines.filter(p => p.status === 'completed').length,
      totalTasks,
      completedTasks,
      totalWorkers: this.workers.size,
      activeWorkers: [...this.workers.values()].filter(w => w.status === 'active').length,
      totalPaid,
    };
  }

  /**
   * Process timed-out tasks (called periodically)
   */
  processTimeouts() {
    const now = Date.now();
    let timedOut = 0;

    for (const [, pipeline] of this.pipelines) {
      if (pipeline.status !== 'active') continue;

      for (const task of pipeline.tasks) {
        if (task.status === 'claimed' && task.deadline && now > task.deadline) {
          task.status = 'available';
          task.worker = null;
          task.claimedAt = null;
          timedOut++;
        }
      }
    }

    return { timedOut };
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  /** Approve task, pay worker, unlock dependents */
  _approveTask(pipeline, task) {
    task.status = 'approved';

    // Pay worker
    if (task.worker && task.reward > 0) {
      const escrowAddr = `iotai_pipeline_${pipeline.pipelineId}`;
      const bal = this.dag.getBalance(escrowAddr);

      if (bal >= task.reward) {
        this.dag.balances.set(escrowAddr, bal - task.reward);
        const workerBal = this.dag.balances.get(task.worker) || 0;
        this.dag.balances.set(task.worker, workerBal + task.reward);
        pipeline.remainingBudget -= task.reward;

        // Update worker stats
        const worker = this.workers.get(task.worker);
        if (worker) {
          worker.tasksCompleted++;
          worker.totalEarned += task.reward;
        }
      }
    }

    // Unlock dependent tasks
    for (const t of pipeline.tasks) {
      if (t.status !== 'pending') continue;
      if (!t.dependsOn || t.dependsOn.length === 0) continue;

      const allDepsComplete = t.dependsOn.every(dep => {
        const depTask = pipeline.tasks.find(x => x.name === dep);
        return depTask && depTask.status === 'approved';
      });

      if (allDepsComplete) {
        t.status = 'available';
      }
    }

    // Check if pipeline is complete
    const allDone = pipeline.tasks.every(t => t.status === 'approved');
    if (allDone) {
      pipeline.status = 'completed';
      pipeline.completedAt = Date.now();

      // Refund unused budget
      const escrowAddr = `iotai_pipeline_${pipeline.pipelineId}`;
      const remaining = this.dag.getBalance(escrowAddr);
      if (remaining > 0) {
        this.dag.balances.set(escrowAddr, 0);
        const ownerBal = this.dag.balances.get(pipeline.owner) || 0;
        this.dag.balances.set(pipeline.owner, ownerBal + remaining);
      }
    }
  }

  /** Calculate pipeline progress */
  _calculateProgress(pipeline) {
    const total = pipeline.tasks.length;
    if (total === 0) return { percent: 100, completed: 0, total: 0 };
    const approved = pipeline.tasks.filter(t => t.status === 'approved').length;
    return {
      percent: Math.round((approved / total) * 100),
      completed: approved,
      total,
      claimed: pipeline.tasks.filter(t => t.status === 'claimed').length,
      submitted: pipeline.tasks.filter(t => t.status === 'submitted').length,
      available: pipeline.tasks.filter(t => t.status === 'available').length,
    };
  }

  _generateId(prefix = 'p') {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
