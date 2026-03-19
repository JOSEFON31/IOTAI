/**
 * IOTAI Consensus Validator
 *
 * Consensus in IOTAI works WITHOUT miners and WITHOUT fees:
 *
 * 1. Every new transaction must validate 2 previous transactions (tips)
 * 2. A transaction is "confirmed" when its cumulative weight exceeds a threshold
 * 3. Double-spend detection: if two conflicting transactions exist, the one
 *    with higher cumulative weight wins (the network converges naturally)
 * 4. Minimum 2 active nodes are required for the network to accept transactions
 *
 * This is similar to IOTA's Tangle consensus but simplified for AI agent use.
 */

export class Validator {
  /**
   * @param {import('../core/dag.js').DAG} dag
   * @param {import('../network/node.js').IOTAINode} node
   */
  constructor(dag, node) {
    this.dag = dag;
    this.node = node;

    // Confirmation threshold: how much cumulative weight a tx needs
    // to be considered "confirmed"
    this.confirmationThreshold = 5;

    // Track pending conflicts for double-spend detection
    /** @type {Map<string, string[]>} address -> [txId, txId, ...] of pending transfers */
    this.pendingTransfers = new Map();
  }

  /**
   * Full validation of a transaction before adding to the DAG
   * @param {import('../core/transaction.js').Transaction} tx
   * @returns {{ valid: boolean, error?: string }}
   */
  validate(tx) {
    // 1. Check minimum network requirement
    if (tx.type !== 'genesis' && !this.node.hasMinimumPeers()) {
      return {
        valid: false,
        error: 'Network requires minimum 2 active nodes for verification',
      };
    }

    // 2. Check parents exist and are valid
    for (const parentId of tx.parents) {
      const parent = this.dag.getTransaction(parentId);
      if (!parent) {
        return { valid: false, error: `Parent ${parentId.substring(0, 12)}... not found` };
      }
    }

    // 3. Check for double spend
    if (tx.type === 'transfer') {
      const conflict = this._detectDoubleSpend(tx);
      if (conflict) {
        return {
          valid: false,
          error: `Double spend detected: conflicts with tx ${conflict.substring(0, 12)}...`,
        };
      }
    }

    // 4. Check timestamp is reasonable (not too far in the future)
    const maxFutureMs = 5 * 60 * 1000; // 5 minutes
    if (tx.timestamp > Date.now() + maxFutureMs) {
      return { valid: false, error: 'Transaction timestamp is too far in the future' };
    }

    // 5. Check parents are not too old (prevent referencing ancient tips)
    const maxParentAge = 24 * 60 * 60 * 1000; // 24 hours
    for (const parentId of tx.parents) {
      const parent = this.dag.getTransaction(parentId);
      if (parent && parent.type !== 'genesis') {
        if (Date.now() - parent.timestamp > maxParentAge) {
          // Warn but don't reject - old tips need to be resolved
          console.warn(`[IOTAI] Warning: parent ${parentId.substring(0, 12)}... is stale`);
        }
      }
    }

    return { valid: true };
  }

  /**
   * Check if a transaction is confirmed (enough cumulative weight)
   * @param {string} txId
   * @returns {boolean}
   */
  isConfirmed(txId) {
    const tx = this.dag.getTransaction(txId);
    if (!tx) return false;
    return tx.cumulativeWeight >= this.confirmationThreshold;
  }

  /**
   * Get confirmation level of a transaction
   * @param {string} txId
   * @returns {{ confirmed: boolean, weight: number, threshold: number, confidence: number }}
   */
  getConfirmationStatus(txId) {
    const tx = this.dag.getTransaction(txId);
    if (!tx) {
      return { confirmed: false, weight: 0, threshold: this.confirmationThreshold, confidence: 0 };
    }

    const confidence = Math.min(1, tx.cumulativeWeight / this.confirmationThreshold);

    return {
      confirmed: tx.cumulativeWeight >= this.confirmationThreshold,
      weight: tx.cumulativeWeight,
      threshold: this.confirmationThreshold,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  /**
   * Resolve conflicts: given two conflicting transactions,
   * determine which one the network should keep
   * @param {string} txId1
   * @param {string} txId2
   * @returns {string} the winning transaction ID
   */
  resolveConflict(txId1, txId2) {
    const tx1 = this.dag.getTransaction(txId1);
    const tx2 = this.dag.getTransaction(txId2);

    if (!tx1) return txId2;
    if (!tx2) return txId1;

    // Higher cumulative weight wins
    if (tx1.cumulativeWeight !== tx2.cumulativeWeight) {
      return tx1.cumulativeWeight > tx2.cumulativeWeight ? txId1 : txId2;
    }

    // Tiebreaker: earlier timestamp
    if (tx1.timestamp !== tx2.timestamp) {
      return tx1.timestamp < tx2.timestamp ? txId1 : txId2;
    }

    // Final tiebreaker: lexicographic hash comparison
    return txId1 < txId2 ? txId1 : txId2;
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Detect if a transaction would cause a double-spend
   * @param {import('../core/transaction.js').Transaction} tx
   * @returns {string|null} conflicting transaction ID or null
   */
  _detectDoubleSpend(tx) {
    if (tx.type !== 'transfer') return null;

    // Check if there's an unconfirmed transaction from the same sender
    // that would overdraw the balance when combined with this one
    const senderBalance = this.dag.getBalance(tx.from);
    let pendingOutflow = 0;

    for (const [id, existingTx] of this.dag.transactions) {
      if (
        existingTx.type === 'transfer' &&
        existingTx.from === tx.from &&
        !this.isConfirmed(id) &&
        id !== tx.id
      ) {
        pendingOutflow += existingTx.amount;
      }
    }

    if (pendingOutflow + tx.amount > senderBalance) {
      // Find the conflicting transaction
      for (const [id, existingTx] of this.dag.transactions) {
        if (
          existingTx.type === 'transfer' &&
          existingTx.from === tx.from &&
          !this.isConfirmed(id)
        ) {
          return id;
        }
      }
    }

    return null;
  }
}
