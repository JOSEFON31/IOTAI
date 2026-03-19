/**
 * IOTAI DAG (Directed Acyclic Graph) - The Tangle
 *
 * This is the core ledger data structure. Instead of a linear blockchain,
 * transactions form a DAG where each new transaction validates 2 previous ones.
 *
 * Key concepts:
 * - Tips: transactions that haven't been validated by any subsequent transaction
 * - Cumulative weight: a transaction's own weight + weight of all transactions that reference it
 * - Tip selection: algorithm to choose which 2 tips a new transaction should validate
 *
 * The DAG is stored in memory and synced across all devices in the P2P network.
 */

import { GENESIS_ID, createGenesis, verifyTransaction, FEE_POOL_ADDRESS } from './transaction.js';

export class DAG {
  constructor() {
    /** @type {Map<string, import('./transaction.js').Transaction>} */
    this.transactions = new Map();

    /** @type {Set<string>} - transaction IDs with no children yet */
    this.tips = new Set();

    /** @type {Map<string, Set<string>>} - parentId -> set of child IDs */
    this.children = new Map();

    /** @type {Map<string, number>} - address -> balance */
    this.balances = new Map();

    /** @type {Set<string>} - seen nonces to prevent replay attacks */
    this.usedNonces = new Set();

    this.genesisId = null;

    // ---- Balance Index (fast lookups) ----
    /** @type {Map<string, string[]>} - address -> list of tx IDs involving this address */
    this.addressIndex = new Map();

    /** @type {Map<string, number>} - address -> total sent */
    this.totalSent = new Map();

    /** @type {Map<string, number>} - address -> total received */
    this.totalReceived = new Map();

    /** @type {Map<string, number>} - address -> transaction count */
    this.txCount = new Map();

    // ---- Fee tracking ----
    this.totalFeesCollected = 0;

    // ---- Pruning state ----
    /** @type {Map<string, object>} - pruned tx snapshots (id -> summary) */
    this.prunedSnapshots = new Map();
    this.lastPruneTime = 0;
    this.pruneThreshold = 10000; // prune when tx count exceeds this
  }

  /**
   * Initialize the DAG with a genesis transaction
   * @param {number} initialSupply - total IOTAI supply
   * @returns {import('./transaction.js').Transaction}
   */
  initialize(initialSupply = 1_000_000_000) {
    const genesis = createGenesis(initialSupply);
    this.transactions.set(genesis.id, genesis);
    this.tips.add(genesis.id);
    this.children.set(genesis.id, new Set());
    this.genesisId = genesis.id;

    // Genesis holds all supply
    this.balances.set('iotai_genesis', initialSupply);

    return genesis;
  }

  /**
   * Add a transaction to the DAG after full validation
   * @param {import('./transaction.js').Transaction} tx
   * @returns {{ success: boolean, error?: string }}
   */
  addTransaction(tx) {
    // Don't add duplicates
    if (this.transactions.has(tx.id)) {
      return { success: false, error: 'Transaction already exists' };
    }

    // Verify cryptographic integrity
    const verification = verifyTransaction(tx);
    if (!verification.valid) {
      return { success: false, error: verification.error };
    }

    // Check nonce hasn't been used (anti-replay)
    if (tx.type !== 'genesis') {
      if (this.usedNonces.has(tx.nonce)) {
        return { success: false, error: 'Nonce already used (replay attack detected)' };
      }
    }

    // Verify parents exist
    for (const parentId of tx.parents) {
      if (!this.transactions.has(parentId)) {
        return { success: false, error: `Parent transaction ${parentId} not found` };
      }
    }

    // Verify sender has sufficient balance for transfers (amount + fee)
    if (tx.type === 'transfer') {
      const senderBalance = this.balances.get(tx.from) || 0;
      const totalCost = tx.amount + (tx.fee || 0);
      if (senderBalance < totalCost) {
        return {
          success: false,
          error: `Insufficient balance: has ${senderBalance}, needs ${totalCost} (${tx.amount} + ${tx.fee || 0} fee)`,
        };
      }
    }

    // All checks passed — add to DAG

    // Record nonce
    if (tx.nonce) {
      this.usedNonces.add(tx.nonce);
    }

    // Store transaction
    this.transactions.set(tx.id, tx);
    this.children.set(tx.id, new Set());

    // Update parent-child relationships
    for (const parentId of tx.parents) {
      this.children.get(parentId)?.add(tx.id);
      // Parent is no longer a tip (it has a child now)
      this.tips.delete(parentId);
    }

    // New transaction starts as a tip
    this.tips.add(tx.id);

    // Update balances for transfers (amount + fee)
    if (tx.type === 'transfer') {
      const fee = tx.fee || 0;
      const senderBalance = this.balances.get(tx.from) || 0;
      const recipientBalance = this.balances.get(tx.to) || 0;

      this.balances.set(tx.from, senderBalance - tx.amount - fee);
      this.balances.set(tx.to, recipientBalance + tx.amount);

      // Fee goes to the fee pool
      if (fee > 0) {
        const poolBalance = this.balances.get(FEE_POOL_ADDRESS) || 0;
        this.balances.set(FEE_POOL_ADDRESS, poolBalance + fee);
        this.totalFeesCollected += fee;
      }

      // Update balance index
      this._updateBalanceIndex(tx.from, tx.id, tx.amount + fee, 0);
      this._updateBalanceIndex(tx.to, tx.id, 0, tx.amount);
    }

    // Index data transactions too
    if (tx.type === 'data') {
      this._updateBalanceIndex(tx.from, tx.id, 0, 0);
    }

    // Update cumulative weights
    this._updateCumulativeWeights(tx.id);

    // Auto-prune if threshold exceeded
    if (this.transactions.size > this.pruneThreshold) {
      this.prune();
    }

    return { success: true };
  }

  /**
   * Select 2 tips for a new transaction to reference
   * Uses weighted random walk from genesis (MCMC-like)
   * If fewer than 2 tips exist, the genesis is used as fallback
   * @returns {string[]} array of 2 transaction IDs
   */
  selectTips() {
    const tipArray = Array.from(this.tips);

    if (tipArray.length === 0) {
      return [this.genesisId, this.genesisId];
    }

    if (tipArray.length === 1) {
      return [tipArray[0], tipArray[0]];
    }

    // Weighted random selection: prefer tips with higher cumulative weight
    // This creates convergence toward the "heaviest" path
    const tip1 = this._weightedRandomTip(tipArray);
    let tip2 = this._weightedRandomTip(tipArray);

    // Try to select different tips for diversity
    let attempts = 0;
    while (tip2 === tip1 && attempts < 5 && tipArray.length > 1) {
      tip2 = this._weightedRandomTip(tipArray);
      attempts++;
    }

    return [tip1, tip2];
  }

  /**
   * Get balance for an address
   * @param {string} address
   * @returns {number}
   */
  getBalance(address) {
    return this.balances.get(address) || 0;
  }

  /**
   * Get a transaction by ID
   * @param {string} id
   * @returns {import('./transaction.js').Transaction | undefined}
   */
  getTransaction(id) {
    return this.transactions.get(id);
  }

  /**
   * Get all tips (unconfirmed transactions)
   * @returns {string[]}
   */
  getTips() {
    return Array.from(this.tips);
  }

  /**
   * Get DAG statistics
   */
  getStats() {
    return {
      totalTransactions: this.transactions.size,
      tipCount: this.tips.size,
      uniqueAddresses: this.balances.size,
      usedNonces: this.usedNonces.size,
      totalFeesCollected: this.totalFeesCollected,
      feePoolBalance: this.balances.get(FEE_POOL_ADDRESS) || 0,
      prunedTransactions: this.prunedSnapshots.size,
    };
  }

  /**
   * Get transaction history for an address
   * @param {string} address
   * @returns {import('./transaction.js').Transaction[]}
   */
  getHistory(address) {
    const history = [];
    for (const tx of this.transactions.values()) {
      if (tx.from === address || tx.to === address) {
        history.push(tx);
      }
    }
    return history.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Query data transactions with filters
   * @param {object} [filters]
   * @param {string} [filters.from] - filter by sender address
   * @param {string} [filters.key] - metadata key to match
   * @param {string} [filters.value] - metadata value to match (requires key)
   * @param {number} [filters.since] - timestamp lower bound (ms)
   * @param {number} [filters.until] - timestamp upper bound (ms)
   * @param {number} [filters.limit=50] - max results
   * @param {number} [filters.offset=0] - skip first N results
   * @returns {{ transactions: Transaction[], total: number }}
   */
  queryData(filters = {}) {
    const { from, key, value, since, until, limit = 50, offset = 0 } = filters;
    const results = [];

    for (const tx of this.transactions.values()) {
      if (tx.type !== 'data') continue;

      if (from && tx.from !== from) continue;
      if (since && tx.timestamp < since) continue;
      if (until && tx.timestamp > until) continue;

      if (key && tx.metadata) {
        if (!(key in tx.metadata)) continue;
        if (value !== undefined && String(tx.metadata[key]) !== String(value)) continue;
      } else if (key) {
        continue; // key filter specified but no metadata
      }

      results.push(tx);
    }

    // Sort newest first
    results.sort((a, b) => b.timestamp - a.timestamp);

    return {
      transactions: results.slice(offset, offset + limit),
      total: results.length,
    };
  }

  /**
   * Full-text search across data transaction metadata
   * @param {string} query - search string
   * @param {number} [limit=20] - max results
   * @returns {Transaction[]}
   */
  searchData(query, limit = 20) {
    const q = query.toLowerCase();
    const results = [];

    for (const tx of this.transactions.values()) {
      if (tx.type !== 'data' || !tx.metadata) continue;

      const json = JSON.stringify(tx.metadata).toLowerCase();
      if (json.includes(q)) {
        results.push(tx);
        if (results.length >= limit) break;
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Export the full DAG state for syncing to another node
   * @returns {object}
   */
  exportState() {
    return {
      transactions: Array.from(this.transactions.values()),
      genesisId: this.genesisId,
    };
  }

  /**
   * Import DAG state from another node
   * @param {object} state
   */
  importState(state) {
    // First add genesis
    const genesis = state.transactions.find((tx) => tx.type === 'genesis');
    if (genesis) {
      this.transactions.set(genesis.id, genesis);
      this.children.set(genesis.id, new Set());
      this.genesisId = genesis.id;
      this.tips.add(genesis.id);
      this.balances.set('iotai_genesis', genesis.amount);
      if (genesis.nonce) this.usedNonces.add(genesis.nonce);
    }

    // Add all other transactions in timestamp order
    // Use direct insertion (like Storage._restoreState) to avoid
    // balance re-validation failures on import
    const sorted = state.transactions
      .filter((tx) => tx.type !== 'genesis')
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of sorted) {
      if (this.transactions.has(tx.id)) continue;

      this.transactions.set(tx.id, tx);
      this.children.set(tx.id, new Set());

      for (const parentId of tx.parents) {
        this.children.get(parentId)?.add(tx.id);
        this.tips.delete(parentId);
      }
      this.tips.add(tx.id);

      if (tx.nonce) this.usedNonces.add(tx.nonce);

      // Update balances for transfers (with fee support)
      if (tx.type === 'transfer') {
        const fee = tx.fee || 0;
        const senderBalance = this.balances.get(tx.from) || 0;
        const recipientBalance = this.balances.get(tx.to) || 0;
        this.balances.set(tx.from, senderBalance - tx.amount - fee);
        this.balances.set(tx.to, recipientBalance + tx.amount);

        if (fee > 0) {
          const poolBalance = this.balances.get(FEE_POOL_ADDRESS) || 0;
          this.balances.set(FEE_POOL_ADDRESS, poolBalance + fee);
          this.totalFeesCollected += fee;
        }

        this._updateBalanceIndex(tx.from, tx.id, tx.amount + fee, 0);
        this._updateBalanceIndex(tx.to, tx.id, 0, tx.amount);
      }

      if (tx.type === 'data') {
        this._updateBalanceIndex(tx.from, tx.id, 0, 0);
      }
    }
  }

  // ============================================================
  // BALANCE INDEX
  // ============================================================

  /**
   * Get detailed balance info for an address (fast indexed lookup)
   * @param {string} address
   * @returns {object}
   */
  getAddressInfo(address) {
    return {
      address,
      balance: this.balances.get(address) || 0,
      totalSent: this.totalSent.get(address) || 0,
      totalReceived: this.totalReceived.get(address) || 0,
      transactionCount: this.txCount.get(address) || 0,
      transactionIds: this.addressIndex.get(address) || [],
    };
  }

  /**
   * Get top addresses by balance
   * @param {number} [limit=20]
   * @returns {Array<{address: string, balance: number}>}
   */
  getTopAddresses(limit = 20) {
    return [...this.balances.entries()]
      .filter(([addr]) => addr !== 'iotai_genesis' && addr !== FEE_POOL_ADDRESS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address, balance]) => ({
        address,
        balance,
        sent: this.totalSent.get(address) || 0,
        received: this.totalReceived.get(address) || 0,
        txCount: this.txCount.get(address) || 0,
      }));
  }

  /**
   * Get fee pool info
   */
  getFeeInfo() {
    return {
      feePoolAddress: FEE_POOL_ADDRESS,
      feePoolBalance: this.balances.get(FEE_POOL_ADDRESS) || 0,
      totalFeesCollected: this.totalFeesCollected,
      feeRate: '1%',
      minFee: 1,
    };
  }

  // ============================================================
  // DAG PRUNING
  // ============================================================

  /**
   * Prune old, deeply confirmed transactions to save memory.
   * Keeps: tips, recent transactions, and transactions with low cumulative weight.
   * Pruned transactions are replaced with lightweight snapshots.
   * @param {object} [options]
   * @param {number} [options.maxAge] - prune txs older than this (ms), default 1 hour
   * @param {number} [options.minWeight] - only prune txs with cumWeight > this, default 10
   * @param {boolean} [options.keepBalanceHistory] - keep balance-affecting tx summaries
   * @returns {{ pruned: number, remaining: number }}
   */
  prune(options = {}) {
    const {
      maxAge = 60 * 60 * 1000, // 1 hour
      minWeight = 10,
      keepBalanceHistory = true,
    } = options;

    const now = Date.now();
    const cutoff = now - maxAge;
    let pruned = 0;

    // Never prune: genesis, tips, recent transactions, or low-weight transactions
    const protectedIds = new Set([this.genesisId, ...this.tips]);

    for (const [txId, tx] of this.transactions.entries()) {
      if (protectedIds.has(txId)) continue;
      if (tx.type === 'genesis') continue;
      if (tx.timestamp > cutoff) continue; // too recent
      if (tx.cumulativeWeight < minWeight) continue; // not confirmed enough

      // Check if any children are tips (don't prune parents of tips)
      const txChildren = this.children.get(txId);
      if (txChildren) {
        let hasUnprunedChild = false;
        for (const childId of txChildren) {
          if (this.tips.has(childId) || (this.transactions.has(childId) && this.transactions.get(childId).timestamp > cutoff)) {
            hasUnprunedChild = true;
            break;
          }
        }
        if (hasUnprunedChild) continue;
      }

      // Save lightweight snapshot before pruning
      if (keepBalanceHistory) {
        this.prunedSnapshots.set(txId, {
          id: txId,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          fee: tx.fee || 0,
          timestamp: tx.timestamp,
          prunedAt: now,
        });
      }

      // Remove the full transaction
      this.transactions.delete(txId);
      // Keep children map entry for DAG structure integrity
      pruned++;
    }

    this.lastPruneTime = now;

    if (pruned > 0) {
      console.log(`[DAG] Pruned ${pruned} old transactions. Remaining: ${this.transactions.size}`);
    }

    return { pruned, remaining: this.transactions.size };
  }

  /**
   * Get pruning statistics
   */
  getPruneStats() {
    return {
      totalActive: this.transactions.size,
      totalPruned: this.prunedSnapshots.size,
      lastPruneTime: this.lastPruneTime,
      pruneThreshold: this.pruneThreshold,
      memoryEstimate: `${Math.round((this.transactions.size * 512) / 1024)} KB`,
    };
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Update balance index for an address
   * @param {string} address
   * @param {string} txId
   * @param {number} sent
   * @param {number} received
   */
  _updateBalanceIndex(address, txId, sent, received) {
    // Address -> tx ID index
    const txIds = this.addressIndex.get(address) || [];
    txIds.push(txId);
    this.addressIndex.set(address, txIds);

    // Aggregates
    this.totalSent.set(address, (this.totalSent.get(address) || 0) + sent);
    this.totalReceived.set(address, (this.totalReceived.get(address) || 0) + received);
    this.txCount.set(address, (this.txCount.get(address) || 0) + 1);
  }

  /**
   * Update cumulative weights walking back from a new transaction to genesis
   * @param {string} txId
   */
  _updateCumulativeWeights(txId) {
    const tx = this.transactions.get(txId);
    if (!tx) return;

    // Walk backwards through parents, incrementing their cumulative weight
    const visited = new Set();
    const queue = [...tx.parents];

    while (queue.length > 0) {
      const parentId = queue.shift();
      if (visited.has(parentId)) continue;
      visited.add(parentId);

      const parent = this.transactions.get(parentId);
      if (!parent) continue;

      parent.cumulativeWeight += 1;

      // Continue walking back
      for (const grandparentId of parent.parents) {
        if (!visited.has(grandparentId)) {
          queue.push(grandparentId);
        }
      }
    }
  }

  /**
   * Weighted random tip selection based on cumulative weight
   * @param {string[]} tips
   * @returns {string}
   */
  _weightedRandomTip(tips) {
    const weights = tips.map((id) => {
      const tx = this.transactions.get(id);
      return tx ? tx.cumulativeWeight : 1;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < tips.length; i++) {
      random -= weights[i];
      if (random <= 0) return tips[i];
    }

    return tips[tips.length - 1];
  }
}
