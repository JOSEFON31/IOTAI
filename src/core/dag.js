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

import { GENESIS_ID, createGenesis, verifyTransaction } from './transaction.js';

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

    // Verify sender has sufficient balance for transfers
    if (tx.type === 'transfer') {
      const senderBalance = this.balances.get(tx.from) || 0;
      if (senderBalance < tx.amount) {
        return {
          success: false,
          error: `Insufficient balance: has ${senderBalance}, needs ${tx.amount}`,
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

    // Update balances for transfers
    if (tx.type === 'transfer') {
      const senderBalance = this.balances.get(tx.from) || 0;
      const recipientBalance = this.balances.get(tx.to) || 0;
      this.balances.set(tx.from, senderBalance - tx.amount);
      this.balances.set(tx.to, recipientBalance + tx.amount);
    }

    // Update cumulative weights
    this._updateCumulativeWeights(tx.id);

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

      // Update balances for transfers
      if (tx.type === 'transfer') {
        const senderBalance = this.balances.get(tx.from) || 0;
        const recipientBalance = this.balances.get(tx.to) || 0;
        this.balances.set(tx.from, senderBalance - tx.amount);
        this.balances.set(tx.to, recipientBalance + tx.amount);
      }
    }
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

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
