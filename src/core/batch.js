/**
 * IOTAI Batch Transactions
 *
 * Send multiple payments in a single atomic operation.
 * Critical for pipelines with many workers, airdrops, and payroll.
 *
 * Benefits:
 *   - Single signature for N transfers
 *   - Atomic: all succeed or all fail
 *   - Lower total fees (1 fee for the batch, not N fees)
 *   - Single DAG entry (less bloat)
 *
 * Example:
 *   batch([
 *     { to: 'worker1', amount: 200 },
 *     { to: 'worker2', amount: 300 },
 *     { to: 'worker3', amount: 500 },
 *   ])
 *   // 1 tx, 1 fee, 3 payments
 */

import { calculateFee, FEE_POOL_ADDRESS } from './transaction.js';

export class BatchProcessor {
  /**
   * @param {object} params
   * @param {import('./dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, BatchRecord>} batchId -> record */
    this.batches = new Map();
  }

  /**
   * Execute a batch of transfers in one atomic operation
   * @param {Wallet} wallet - Sender wallet
   * @param {string[]} tips - DAG tips
   * @param {object} params
   * @param {Array<{to: string, amount: number, memo?: string}>} params.transfers - List of transfers
   * @returns {{ batchId: string, txId: string, totalAmount: number, fee: number, count: number }}
   */
  executeBatch(wallet, tips, { transfers }) {
    if (!transfers || transfers.length === 0) throw new Error('At least one transfer required');
    if (transfers.length > 100) throw new Error('Max 100 transfers per batch');

    // Validate all transfers
    const totalAmount = transfers.reduce((sum, t) => {
      if (!t.to) throw new Error('Each transfer needs a "to" address');
      if (!t.amount || t.amount <= 0) throw new Error(`Invalid amount for ${t.to}`);
      if (t.to === wallet.address) throw new Error('Cannot send to yourself in batch');
      return sum + t.amount;
    }, 0);

    // Calculate single fee for entire batch
    const fee = calculateFee(totalAmount);
    const totalCost = totalAmount + fee;

    // Check balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < totalCost) {
      throw new Error(`Insufficient balance. Need ${totalCost} (${totalAmount} + ${fee} fee), have ${balance}`);
    }

    const batchId = 'batch_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    // Record batch on DAG as a single data transaction
    const tx = wallet.sendData(tips, {
      _batch: 'execute',
      batchId,
      sender: wallet.address,
      transfers: transfers.map(t => ({
        to: t.to,
        amount: t.amount,
        memo: t.memo || '',
      })),
      totalAmount,
      fee,
      count: transfers.length,
      executedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Execute all transfers atomically
    // Deduct total from sender
    const senderBal = this.dag.getBalance(wallet.address);
    this.dag.balances.set(wallet.address, senderBal - totalCost);

    // Credit each recipient
    for (const t of transfers) {
      const recipientBal = this.dag.balances.get(t.to) || 0;
      this.dag.balances.set(t.to, recipientBal + t.amount);
    }

    // Pay fee
    const feePoolBal = this.dag.balances.get(FEE_POOL_ADDRESS) || 0;
    this.dag.balances.set(FEE_POOL_ADDRESS, feePoolBal + fee);

    // Update balance index if available
    if (this.dag._updateBalanceIndex) {
      this.dag._updateBalanceIndex(wallet.address);
      for (const t of transfers) {
        this.dag._updateBalanceIndex(t.to);
      }
      this.dag._updateBalanceIndex(FEE_POOL_ADDRESS);
    }

    // Record batch
    const record = {
      batchId,
      txId: tx.id,
      sender: wallet.address,
      transfers: transfers.map(t => ({ to: t.to, amount: t.amount, memo: t.memo || '' })),
      totalAmount,
      fee,
      count: transfers.length,
      executedAt: Date.now(),
    };
    this.batches.set(batchId, record);

    return { batchId, txId: tx.id, totalAmount, fee, count: transfers.length };
  }

  /**
   * Get batch details
   */
  getBatch(batchId) {
    return this.batches.get(batchId) || null;
  }

  /**
   * Get batches sent by an address
   */
  getBatchesBySender(address, limit = 20) {
    return [...this.batches.values()]
      .filter(b => b.sender === address)
      .sort((a, b) => b.executedAt - a.executedAt)
      .slice(0, limit);
  }

  /**
   * Get stats
   */
  getStats() {
    let totalTransferred = 0;
    let totalFees = 0;
    let totalPayments = 0;
    for (const b of this.batches.values()) {
      totalTransferred += b.totalAmount;
      totalFees += b.fee;
      totalPayments += b.count;
    }
    return {
      totalBatches: this.batches.size,
      totalPayments,
      totalTransferred,
      totalFees,
      avgBatchSize: this.batches.size > 0 ? Math.round(totalPayments / this.batches.size) : 0,
    };
  }
}
