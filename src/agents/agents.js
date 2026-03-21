/**
 * IOTAI AI Agent Chat Marketplace
 *
 * Users pay IOTAI to query AI agents. Agent owners register their bots,
 * set a model + price per query, and run a polling service that forwards
 * queries to their AI model and posts responses back to the DAG.
 *
 * Data Model (stored as tx.metadata):
 *   - _agents:register  → Agent registration (name, model, price, owner)
 *   - _agents:update    → Agent config update
 *   - _agents:query     → User query (message, payment ref)
 *   - _agents:response  → Agent response (AI-generated text)
 *   - _agents:review    → User review (rating, comment)
 */

const ALLOWED_MODELS = [
  'gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo',
  'claude-opus', 'claude-sonnet', 'claude-haiku',
  'gemini-pro', 'gemini-flash',
  'llama-3', 'mixtral', 'deepseek', 'custom',
];

const MAX_QUERY_LENGTH = 4000;
const MAX_RESPONSE_LENGTH = 8000;
const QUERY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export class Agents {
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, object>} agentId -> agent */
    this.agents = new Map();
    /** @type {Map<string, string[]>} ownerAddress -> agentId[] */
    this.agentsByOwner = new Map();
    /** @type {Map<string, object>} queryId -> query */
    this.queries = new Map();
    /** @type {Map<string, string[]>} agentId -> queryId[] */
    this.queriesByAgent = new Map();
    /** @type {Map<string, string[]>} userAddress -> queryId[] */
    this.queriesByUser = new Map();
    /** @type {Map<string, string[]>} conversationId -> queryId[] (ordered) */
    this.conversations = new Map();
    /** @type {Map<string, object[]>} agentId -> reviews[] */
    this.reviews = new Map();

    this._rebuildIndex();
  }

  // ============================================================
  // REGISTRATION
  // ============================================================

  registerAgent(wallet, tips, { name, description, model, pricePerQuery, tags, webhookUrl }) {
    if (!name || name.length < 2 || name.length > 50) throw new Error('Name must be 2-50 characters');
    if (!description || description.length > 500) throw new Error('Description required (max 500 chars)');
    if (!model || !ALLOWED_MODELS.includes(model)) throw new Error('Invalid model. Allowed: ' + ALLOWED_MODELS.join(', '));
    if (!pricePerQuery || pricePerQuery < 1) throw new Error('Price per query must be at least 1 IOTAI');

    // Check name uniqueness
    for (const a of this.agents.values()) {
      if (a.name.toLowerCase() === name.toLowerCase()) throw new Error('Agent name already taken');
    }

    const agentId = 'ag_' + this._generateId();
    const metadata = {
      _agents: 'register',
      agentId,
      name,
      description,
      model,
      pricePerQuery,
      owner: wallet.address,
      tags: tags || [],
      webhookUrl: webhookUrl || null,
      status: 'online',
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexAgent(tx);
    return { agentId, txId: tx.id };
  }

  updateAgent(wallet, tips, { agentId, name, description, model, pricePerQuery, status, tags, webhookUrl }) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.owner !== wallet.address) throw new Error('Only the owner can update this agent');

    if (model && !ALLOWED_MODELS.includes(model)) throw new Error('Invalid model');
    if (pricePerQuery !== undefined && pricePerQuery < 1) throw new Error('Price must be at least 1 IOTAI');
    if (status && !['online', 'offline'].includes(status)) throw new Error('Status must be online or offline');

    const metadata = {
      _agents: 'update',
      agentId,
      updatedAt: Date.now(),
    };
    if (name !== undefined) metadata.name = name;
    if (description !== undefined) metadata.description = description;
    if (model !== undefined) metadata.model = model;
    if (pricePerQuery !== undefined) metadata.pricePerQuery = pricePerQuery;
    if (status !== undefined) metadata.status = status;
    if (tags !== undefined) metadata.tags = tags;
    if (webhookUrl !== undefined) metadata.webhookUrl = webhookUrl;

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexUpdate(tx);
    return { txId: tx.id };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  submitQuery(wallet, tips, { agentId, message, conversationId }) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.status !== 'online') throw new Error('Agent is currently offline');
    if (!message || message.length > MAX_QUERY_LENGTH) throw new Error('Message required (max ' + MAX_QUERY_LENGTH + ' chars)');

    // Check user balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < agent.pricePerQuery) throw new Error('Insufficient balance. Need ' + agent.pricePerQuery + ' IOTAI');

    const queryId = 'q_' + this._generateId();
    const convId = conversationId || ('conv_' + this._generateId());

    // Transfer IOTAI to agent owner
    const paymentTx = wallet.send(agent.owner, agent.pricePerQuery, tips, {
      _agents: 'payment',
      queryId,
      agentId,
      purpose: 'agent_query_payment',
    });
    const payResult = this.dag.addTransaction(paymentTx);
    if (!payResult.success) throw new Error(payResult.error);

    // Post query to DAG
    const tips2 = this.dag.selectTips();
    const queryMetadata = {
      _agents: 'query',
      queryId,
      agentId,
      conversationId: convId,
      userAddress: wallet.address,
      message,
      paymentTxId: paymentTx.id,
      status: 'pending',
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips2, queryMetadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexQuery(tx);
    return { queryId, conversationId: convId, paymentTxId: paymentTx.id, cost: agent.pricePerQuery };
  }

  submitResponse(wallet, tips, { queryId, response, tokensUsed }) {
    const query = this.queries.get(queryId);
    if (!query) throw new Error('Query not found');
    if (query.status !== 'pending') throw new Error('Query is not pending (status: ' + query.status + ')');

    const agent = this.agents.get(query.agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.owner !== wallet.address) throw new Error('Only the agent owner can respond');

    if (!response || response.length > MAX_RESPONSE_LENGTH) throw new Error('Response required (max ' + MAX_RESPONSE_LENGTH + ' chars)');

    const metadata = {
      _agents: 'response',
      queryId,
      agentId: query.agentId,
      response,
      model: agent.model,
      tokensUsed: tokensUsed || 0,
      respondedAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexResponse(tx);
    return { txId: tx.id, queryId };
  }

  // ============================================================
  // REVIEWS
  // ============================================================

  reviewAgent(wallet, tips, { agentId, queryId, rating, comment }) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (rating < 1 || rating > 5) throw new Error('Rating must be 1-5');

    if (queryId) {
      const query = this.queries.get(queryId);
      if (!query) throw new Error('Query not found');
      if (query.userAddress !== wallet.address) throw new Error('You can only review queries you made');
      if (query.status !== 'completed') throw new Error('Can only review completed queries');
    }

    const metadata = {
      _agents: 'review',
      agentId,
      queryId: queryId || null,
      rating,
      comment: (comment || '').substring(0, 500),
      reviewer: wallet.address,
      reviewedAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexReview(tx);
    return { txId: tx.id };
  }

  // ============================================================
  // READ METHODS
  // ============================================================

  getAgents({ model, maxPrice, minRating, status, search, sortBy, limit, offset } = {}) {
    let list = [...this.agents.values()];

    if (model) list = list.filter(a => a.model === model);
    if (maxPrice) list = list.filter(a => a.pricePerQuery <= maxPrice);
    if (status) list = list.filter(a => a.status === status);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    }

    // Enrich with stats
    list = list.map(a => this._enrichAgent(a));

    if (minRating) list = list.filter(a => a.avgRating >= minRating);

    // Sort
    if (sortBy === 'price-asc') list.sort((a, b) => a.pricePerQuery - b.pricePerQuery);
    else if (sortBy === 'price-desc') list.sort((a, b) => b.pricePerQuery - a.pricePerQuery);
    else if (sortBy === 'rating') list.sort((a, b) => b.avgRating - a.avgRating);
    else if (sortBy === 'popular') list.sort((a, b) => b.totalQueries - a.totalQueries);
    else list.sort((a, b) => b.createdAt - a.createdAt); // newest first

    const total = list.length;
    const off = offset || 0;
    const lim = limit || 50;
    list = list.slice(off, off + lim);

    return { agents: list, total };
  }

  getAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return this._enrichAgent(agent);
  }

  getAgentsByOwner(address) {
    const ids = this.agentsByOwner.get(address) || [];
    return ids.map(id => this._enrichAgent(this.agents.get(id))).filter(Boolean);
  }

  getPendingQueries(agentId) {
    const queryIds = this.queriesByAgent.get(agentId) || [];
    return queryIds
      .map(id => this.queries.get(id))
      .filter(q => q && q.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getQuery(queryId) {
    return this.queries.get(queryId) || null;
  }

  getConversation(conversationId) {
    const queryIds = this.conversations.get(conversationId) || [];
    return queryIds
      .map(id => this.queries.get(id))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getUserConversations(address) {
    const queryIds = this.queriesByUser.get(address) || [];
    const convMap = new Map();
    for (const qid of queryIds) {
      const q = this.queries.get(qid);
      if (!q) continue;
      if (!convMap.has(q.conversationId)) {
        const agent = this.agents.get(q.agentId);
        convMap.set(q.conversationId, {
          conversationId: q.conversationId,
          agentId: q.agentId,
          agentName: agent?.name || 'Unknown',
          agentModel: agent?.model || 'unknown',
          lastMessage: q.message,
          lastTime: q.createdAt,
          messageCount: 0,
        });
      }
      const conv = convMap.get(q.conversationId);
      conv.messageCount++;
      if (q.createdAt > conv.lastTime) {
        conv.lastTime = q.createdAt;
        conv.lastMessage = q.message;
      }
    }
    return [...convMap.values()].sort((a, b) => b.lastTime - a.lastTime);
  }

  getStats() {
    let onlineAgents = 0;
    for (const a of this.agents.values()) {
      if (a.status === 'online') onlineAgents++;
    }
    let completedQueries = 0;
    let pendingQueries = 0;
    for (const q of this.queries.values()) {
      if (q.status === 'completed') completedQueries++;
      else if (q.status === 'pending') pendingQueries++;
    }
    return {
      totalAgents: this.agents.size,
      onlineAgents,
      totalQueries: this.queries.size,
      completedQueries,
      pendingQueries,
      totalReviews: [...this.reviews.values()].reduce((sum, r) => sum + r.length, 0),
    };
  }

  getAllowedModels() {
    return ALLOWED_MODELS;
  }

  // ============================================================
  // EXPIRY
  // ============================================================

  processExpired() {
    const now = Date.now();
    let expired = 0;
    for (const q of this.queries.values()) {
      if (q.status === 'pending' && (now - q.createdAt) > QUERY_TIMEOUT) {
        q.status = 'expired';
        expired++;
      }
    }
    return { expired };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  resync() { this._rebuildIndex(); }

  _rebuildIndex() {
    this.agents.clear();
    this.agentsByOwner.clear();
    this.queries.clear();
    this.queriesByAgent.clear();
    this.queriesByUser.clear();
    this.conversations.clear();
    this.reviews.clear();

    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._agents)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._agents) {
        case 'register': this._indexAgent(tx); break;
        case 'update': this._indexUpdate(tx); break;
        case 'query': this._indexQuery(tx); break;
        case 'response': this._indexResponse(tx); break;
        case 'review': this._indexReview(tx); break;
      }
    }

    if (this.agents.size > 0) {
      console.log(`[Agents] Indexed ${this.agents.size} agents, ${this.queries.size} queries`);
    }
  }

  _indexAgent(tx) {
    const m = tx.metadata;
    this.agents.set(m.agentId, {
      agentId: m.agentId,
      name: m.name,
      description: m.description,
      model: m.model,
      pricePerQuery: m.pricePerQuery,
      owner: m.owner || tx.from,
      tags: m.tags || [],
      webhookUrl: m.webhookUrl || null,
      status: m.status || 'online',
      createdAt: m.createdAt || tx.timestamp,
    });

    const owner = m.owner || tx.from;
    const list = this.agentsByOwner.get(owner) || [];
    if (!list.includes(m.agentId)) list.push(m.agentId);
    this.agentsByOwner.set(owner, list);
  }

  _indexUpdate(tx) {
    const m = tx.metadata;
    const agent = this.agents.get(m.agentId);
    if (!agent) return;

    if (m.name !== undefined) agent.name = m.name;
    if (m.description !== undefined) agent.description = m.description;
    if (m.model !== undefined) agent.model = m.model;
    if (m.pricePerQuery !== undefined) agent.pricePerQuery = m.pricePerQuery;
    if (m.status !== undefined) agent.status = m.status;
    if (m.tags !== undefined) agent.tags = m.tags;
    if (m.webhookUrl !== undefined) agent.webhookUrl = m.webhookUrl;
  }

  _indexQuery(tx) {
    const m = tx.metadata;
    this.queries.set(m.queryId, {
      queryId: m.queryId,
      agentId: m.agentId,
      conversationId: m.conversationId,
      userAddress: m.userAddress || tx.from,
      message: m.message,
      response: null,
      paymentTxId: m.paymentTxId,
      status: m.status || 'pending',
      createdAt: m.createdAt || tx.timestamp,
      respondedAt: null,
      tokensUsed: 0,
    });

    // Index by agent
    const agentList = this.queriesByAgent.get(m.agentId) || [];
    agentList.push(m.queryId);
    this.queriesByAgent.set(m.agentId, agentList);

    // Index by user
    const userAddr = m.userAddress || tx.from;
    const userList = this.queriesByUser.get(userAddr) || [];
    userList.push(m.queryId);
    this.queriesByUser.set(userAddr, userList);

    // Index by conversation
    const convList = this.conversations.get(m.conversationId) || [];
    convList.push(m.queryId);
    this.conversations.set(m.conversationId, convList);
  }

  _indexResponse(tx) {
    const m = tx.metadata;
    const query = this.queries.get(m.queryId);
    if (!query) return;

    query.response = m.response;
    query.status = 'completed';
    query.respondedAt = m.respondedAt || tx.timestamp;
    query.tokensUsed = m.tokensUsed || 0;
    query.model = m.model;
  }

  _indexReview(tx) {
    const m = tx.metadata;
    const list = this.reviews.get(m.agentId) || [];
    list.push({
      rating: m.rating,
      comment: m.comment || '',
      reviewer: m.reviewer || tx.from,
      queryId: m.queryId,
      reviewedAt: m.reviewedAt || tx.timestamp,
    });
    this.reviews.set(m.agentId, list);
  }

  // ============================================================
  // HELPERS
  // ============================================================

  _enrichAgent(agent) {
    if (!agent) return null;
    const queryIds = this.queriesByAgent.get(agent.agentId) || [];
    const revs = this.reviews.get(agent.agentId) || [];
    const avgRating = revs.length > 0 ? Math.round((revs.reduce((s, r) => s + r.rating, 0) / revs.length) * 10) / 10 : 0;

    return {
      ...agent,
      totalQueries: queryIds.length,
      completedQueries: queryIds.filter(id => this.queries.get(id)?.status === 'completed').length,
      totalReviews: revs.length,
      avgRating,
    };
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
