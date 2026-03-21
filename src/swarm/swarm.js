/**
 * IOTAI Swarm — Decentralized AI
 *
 * Coordinates multiple AI agents to form a collective intelligence.
 * Complex queries are decomposed into subtasks, distributed across agents
 * via the Orchestrator, and results aggregated into a final response.
 *
 * Simple queries go directly to the best available agent.
 * Complex queries create a pipeline: analyze → generate → review → aggregate.
 *
 * All coordination happens on the DAG — no central server needed.
 *
 * Data Model (stored as tx.metadata):
 *   - _swarm:job          → Swarm job (query, type, budget, status)
 *   - _swarm:aggregation  → Final aggregated response
 */

const QUERY_TYPES = {
  code:         { name: 'Code Generation', subtasks: ['requirements', 'implementation', 'review'] },
  analysis:     { name: 'Data Analysis',   subtasks: ['extract', 'process', 'summarize'] },
  research:     { name: 'Research',        subtasks: ['search', 'compile', 'synthesize'] },
  creative:     { name: 'Creative',        subtasks: ['brainstorm', 'draft', 'refine'] },
  conversation: { name: 'Conversation',    subtasks: [] }, // no decomposition
};

const SUBTASK_TEMPLATES = {
  // Code
  requirements: { capability: 'analysis', prompt: 'Analyze the following request and extract clear technical requirements. List each requirement:\n\n', rewardPct: 0.20 },
  implementation: { capability: 'code', prompt: 'Based on these requirements, write the complete implementation:\n\nRequirements:\n{prev}\n\nOriginal request:\n', rewardPct: 0.50 },
  review: { capability: 'review', prompt: 'Review the following code for bugs, security issues, and improvements. Provide the corrected final version:\n\nCode:\n{prev}\n\nOriginal request:\n', rewardPct: 0.30 },

  // Analysis
  extract: { capability: 'analysis', prompt: 'Extract the key data points and structure from this request:\n\n', rewardPct: 0.25 },
  process: { capability: 'analysis', prompt: 'Process and analyze the following extracted data:\n\n{prev}\n\nOriginal request:\n', rewardPct: 0.40 },
  summarize: { capability: 'analysis', prompt: 'Create a clear, comprehensive summary of this analysis:\n\n{prev}\n\nOriginal request:\n', rewardPct: 0.35 },

  // Research
  search: { capability: 'general', prompt: 'Research and gather information about:\n\n', rewardPct: 0.30 },
  compile: { capability: 'analysis', prompt: 'Compile and organize the following research findings:\n\n{prev}\n\nOriginal request:\n', rewardPct: 0.35 },
  synthesize: { capability: 'general', prompt: 'Synthesize all findings into a comprehensive, well-structured response:\n\n{prev}\n\nOriginal request:\n', rewardPct: 0.35 },

  // Creative
  brainstorm: { capability: 'general', prompt: 'Generate creative ideas and approaches for:\n\n', rewardPct: 0.25 },
  draft: { capability: 'general', prompt: 'Using these ideas, create a complete first draft:\n\nIdeas:\n{prev}\n\nOriginal request:\n', rewardPct: 0.45 },
  refine: { capability: 'review', prompt: 'Polish and refine this draft for quality and coherence:\n\n{prev}\n\nOriginal request:\n', rewardPct: 0.30 },
};

const MIN_BUDGET = 3;
const JOB_TIMEOUT = 10 * 60 * 1000; // 10 minutes

export class Swarm {
  constructor({ dag, agents, orchestrator }) {
    this.dag = dag;
    this.agents = agents;
    this.orchestrator = orchestrator;

    /** @type {Map<string, object>} jobId -> job */
    this.jobs = new Map();
    /** @type {Map<string, string[]>} userAddress -> jobId[] */
    this.jobsByUser = new Map();

    this._rebuildIndex();
  }

  // ============================================================
  // SUBMIT QUERY
  // ============================================================

  submitSwarmQuery(wallet, tips, { message, type, maxBudget }) {
    if (!message || message.length > 8000) throw new Error('Message required (max 8000 chars)');
    if (maxBudget && maxBudget < MIN_BUDGET) throw new Error('Minimum budget is ' + MIN_BUDGET + ' IOTAI');

    // Auto-detect query type
    const queryType = type && QUERY_TYPES[type] ? type : this._detectType(message);
    const typeConfig = QUERY_TYPES[queryType];

    // Check available agents
    const onlineAgents = this.agents.getAgents({ status: 'online' });
    if (!onlineAgents.agents || onlineAgents.agents.length === 0) {
      throw new Error('No agents online. Try again later.');
    }

    // Simple query — route to single best agent
    if (queryType === 'conversation' || typeConfig.subtasks.length === 0) {
      return this._submitSimple(wallet, tips, message, maxBudget, onlineAgents.agents);
    }

    // Complex query — decompose into pipeline
    return this._submitComplex(wallet, tips, message, queryType, typeConfig, maxBudget, onlineAgents.agents);
  }

  _submitSimple(wallet, tips, message, maxBudget, agentList) {
    // Pick cheapest agent within budget
    const affordable = maxBudget
      ? agentList.filter(a => a.pricePerQuery <= maxBudget)
      : agentList;
    if (affordable.length === 0) throw new Error('No agents within your budget');

    // Sort by rating desc, then price asc
    affordable.sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0) || a.pricePerQuery - b.pricePerQuery);
    const agent = affordable[0];

    // Submit via agents module
    const result = this.agents.submitQuery(wallet, tips, {
      agentId: agent.agentId,
      message,
    });

    // Record swarm job
    const jobId = 'sw_' + this._generateId();
    const job = {
      jobId,
      type: 'simple',
      queryType: 'conversation',
      message,
      userAddress: wallet.address,
      agentId: agent.agentId,
      agentName: agent.name,
      queryId: result.queryId,
      conversationId: result.conversationId,
      cost: result.cost,
      status: 'pending',
      pipelineId: null,
      subtasks: [],
      response: null,
      createdAt: Date.now(),
    };

    // Store on DAG
    const tips2 = this.dag.selectTips();
    const tx = wallet.sendData(tips2, { _swarm: 'job', ...job });
    this.dag.addTransaction(tx);
    this._indexJob(tx);

    return { jobId, type: 'simple', agentId: agent.agentId, agentName: agent.name, queryId: result.queryId, cost: result.cost };
  }

  _submitComplex(wallet, tips, message, queryType, typeConfig, maxBudget, agentList) {
    const subtaskNames = typeConfig.subtasks;
    const numSubtasks = subtaskNames.length;

    // Estimate cost: sum of cheapest agents for each subtask
    let estimatedCost = 0;
    const assignments = [];
    for (const stName of subtaskNames) {
      const template = SUBTASK_TEMPLATES[stName];
      // Find agents with matching capability
      let candidates = agentList.filter(a =>
        a.tags?.includes(template.capability) || template.capability === 'general'
      );
      if (candidates.length === 0) candidates = agentList; // fallback: any agent

      // Sort by rating, then price
      candidates.sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0) || a.pricePerQuery - b.pricePerQuery);
      const chosen = candidates[0];
      estimatedCost += chosen.pricePerQuery;
      assignments.push({ subtask: stName, agent: chosen });
    }

    if (maxBudget && estimatedCost > maxBudget) {
      throw new Error(`Estimated cost ${estimatedCost} IOTAI exceeds budget ${maxBudget}. Need at least ${estimatedCost} IOTAI for ${numSubtasks} subtasks.`);
    }

    // Check balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < estimatedCost) {
      throw new Error(`Insufficient balance. Need ${estimatedCost} IOTAI, have ${balance}`);
    }

    const jobId = 'sw_' + this._generateId();

    // Build pipeline tasks for the Orchestrator
    const pipelineTasks = subtaskNames.map((stName, i) => {
      const template = SUBTASK_TEMPLATES[stName];
      const assigned = assignments[i];
      return {
        name: stName,
        capability: template.capability,
        reward: assigned.agent.pricePerQuery,
        dependsOn: i === 0 ? [] : [subtaskNames[i - 1]], // chain dependencies
        timeout: 5 * 60 * 1000, // 5 min per subtask
        description: `[SWARM:${jobId}] ${template.prompt}${message}`,
      };
    });

    const totalBudget = pipelineTasks.reduce((s, t) => s + t.reward, 0);

    // Create pipeline via Orchestrator
    const pipelineResult = this.orchestrator.createPipeline(wallet, this.dag.selectTips(), {
      name: `swarm_${jobId}`,
      description: `Swarm job: ${queryType} — ${message.substring(0, 100)}`,
      tasks: pipelineTasks,
      budget: totalBudget,
      autoApprove: true,
    });

    // Record swarm job
    const subtaskDetails = subtaskNames.map((stName, i) => ({
      name: stName,
      capability: SUBTASK_TEMPLATES[stName].capability,
      promptTemplate: SUBTASK_TEMPLATES[stName].prompt,
      assignedAgent: assignments[i].agent.agentId,
      assignedAgentName: assignments[i].agent.name,
      reward: assignments[i].agent.pricePerQuery,
      status: 'pending',
      result: null,
    }));

    const job = {
      jobId,
      type: 'complex',
      queryType,
      message,
      userAddress: wallet.address,
      agentId: null,
      queryId: null,
      conversationId: null,
      cost: totalBudget,
      pipelineId: pipelineResult.pipelineId,
      subtasks: subtaskDetails,
      status: 'processing',
      response: null,
      createdAt: Date.now(),
    };

    const tips2 = this.dag.selectTips();
    const tx = wallet.sendData(tips2, { _swarm: 'job', ...job });
    this.dag.addTransaction(tx);
    this._indexJob(tx);

    return {
      jobId,
      type: 'complex',
      queryType: typeConfig.name,
      subtaskCount: numSubtasks,
      estimatedCost: totalBudget,
      pipelineId: pipelineResult.pipelineId,
      subtasks: subtaskDetails.map(s => ({ name: s.name, agent: s.assignedAgentName, reward: s.reward })),
    };
  }

  // ============================================================
  // AGGREGATION
  // ============================================================

  checkAndAggregate(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.type !== 'complex' || job.status === 'completed') return null;

    const pipeline = this.orchestrator.getPipeline(job.pipelineId);
    if (!pipeline) return null;

    // Update subtask statuses from pipeline
    for (let i = 0; i < job.subtasks.length; i++) {
      const pTask = pipeline.tasks[i];
      if (pTask) {
        job.subtasks[i].status = pTask.status;
        if (pTask.result) job.subtasks[i].result = pTask.result;
      }
    }

    // Check if all subtasks are done
    const allDone = job.subtasks.every(s => s.status === 'approved' || s.status === 'submitted');
    if (!allDone) return { status: 'processing', progress: pipeline.progress };

    // Aggregate results
    const results = job.subtasks.map(s => s.result || '').filter(Boolean);
    const lastResult = results[results.length - 1] || results.join('\n\n---\n\n');

    job.response = lastResult;
    job.status = 'completed';

    return { status: 'completed', response: lastResult };
  }

  // ============================================================
  // READ METHODS
  // ============================================================

  getSwarmJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    // For simple jobs, check agent query status
    if (job.type === 'simple' && job.queryId) {
      const query = this.agents.getQuery(job.queryId);
      if (query) {
        job.status = query.status;
        if (query.response) job.response = query.response;
      }
    }

    // For complex jobs, check pipeline progress
    if (job.type === 'complex' && job.pipelineId && job.status !== 'completed') {
      this.checkAndAggregate(jobId);
    }

    return { ...job };
  }

  getUserJobs(address) {
    const ids = this.jobsByUser.get(address) || [];
    return ids.map(id => this.getSwarmJob(id)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }

  getSwarmStats() {
    const onlineAgents = this.agents.getAgents({ status: 'online' });
    const modelCounts = {};
    let minPrice = Infinity;
    let maxPrice = 0;

    for (const a of (onlineAgents.agents || [])) {
      modelCounts[a.model] = (modelCounts[a.model] || 0) + 1;
      if (a.pricePerQuery < minPrice) minPrice = a.pricePerQuery;
      if (a.pricePerQuery > maxPrice) maxPrice = a.pricePerQuery;
    }

    let completedJobs = 0;
    let totalJobs = 0;
    for (const j of this.jobs.values()) {
      totalJobs++;
      if (j.status === 'completed') completedJobs++;
    }

    return {
      totalAgentsOnline: onlineAgents.agents?.length || 0,
      modelCounts,
      priceRange: { min: minPrice === Infinity ? 0 : minPrice, max: maxPrice },
      totalJobs,
      completedJobs,
      queryTypes: Object.keys(QUERY_TYPES).map(k => ({ type: k, name: QUERY_TYPES[k].name, subtasks: QUERY_TYPES[k].subtasks.length })),
    };
  }

  getAvailableModels() {
    const online = this.agents.getAgents({ status: 'online' });
    const models = {};
    for (const a of (online.agents || [])) {
      if (!models[a.model]) {
        models[a.model] = { model: a.model, agentCount: 0, minPrice: Infinity, maxPrice: 0 };
      }
      models[a.model].agentCount++;
      if (a.pricePerQuery < models[a.model].minPrice) models[a.model].minPrice = a.pricePerQuery;
      if (a.pricePerQuery > models[a.model].maxPrice) models[a.model].maxPrice = a.pricePerQuery;
    }
    return Object.values(models);
  }

  // ============================================================
  // EXPIRY
  // ============================================================

  processExpired() {
    const now = Date.now();
    let expired = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'processing' || job.status === 'pending') {
        if (now - job.createdAt > JOB_TIMEOUT) {
          job.status = 'expired';
          expired++;
        }
      }
    }
    return { expired };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  resync() { this._rebuildIndex(); }

  _rebuildIndex() {
    this.jobs.clear();
    this.jobsByUser.clear();

    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._swarm)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._swarm) {
        case 'job': this._indexJob(tx); break;
        case 'aggregation': this._indexAggregation(tx); break;
      }
    }

    if (this.jobs.size > 0) {
      console.log(`[Swarm] Indexed ${this.jobs.size} jobs`);
    }
  }

  _indexJob(tx) {
    const m = tx.metadata;
    this.jobs.set(m.jobId, {
      jobId: m.jobId,
      type: m.type,
      queryType: m.queryType,
      message: m.message,
      userAddress: m.userAddress || tx.from,
      agentId: m.agentId,
      agentName: m.agentName,
      queryId: m.queryId,
      conversationId: m.conversationId,
      cost: m.cost,
      pipelineId: m.pipelineId,
      subtasks: m.subtasks || [],
      status: m.status || 'pending',
      response: m.response || null,
      createdAt: m.createdAt || tx.timestamp,
    });

    const addr = m.userAddress || tx.from;
    const list = this.jobsByUser.get(addr) || [];
    if (!list.includes(m.jobId)) list.push(m.jobId);
    this.jobsByUser.set(addr, list);
  }

  _indexAggregation(tx) {
    const m = tx.metadata;
    const job = this.jobs.get(m.jobId);
    if (job) {
      job.response = m.response;
      job.status = 'completed';
    }
  }

  // ============================================================
  // HELPERS
  // ============================================================

  _detectType(message) {
    const msg = message.toLowerCase();
    if (/\b(code|function|api|class|implement|programa|código|función)\b/.test(msg)) return 'code';
    if (/\b(analy[sz]|data|estadístic|metric|csv|report)\b/.test(msg)) return 'analysis';
    if (/\b(research|investigat?e?|compar[ae]|study|estudi)\b/.test(msg)) return 'research';
    if (/\b(write|essay|article|story|artículo|historia|creativ)\b/.test(msg)) return 'creative';
    return 'conversation';
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
