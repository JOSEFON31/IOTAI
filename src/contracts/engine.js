/**
 * IOTAI Smart Contracts Engine
 *
 * Lightweight conditional contracts for AI agents.
 * Contracts define conditions and actions that execute automatically
 * when matching data transactions appear on the DAG.
 *
 * Example contract:
 *   conditions: [{ field: 'metadata.accuracy', operator: '>=', value: 0.95 }]
 *   actions: [{ type: 'transfer', to: 'iotai_worker...', amount: 500 }]
 *
 * Supported operators: ==, !=, >, <, >=, <=, contains, exists
 * Supported actions: transfer, store_data, notify
 */

export class ContractEngine {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, Contract>} */
    this.contracts = new Map();

    /** @type {Map<string, Execution[]>} contractId -> executions */
    this.executions = new Map();

    /** @type {Map<string, Contract[]>} ownerAddress -> contracts */
    this.contractsByOwner = new Map();
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Deploy a new smart contract
   * @returns {{ contractId: string, txId: string }}
   */
  deploy(wallet, tips, { name, description, conditions, actions, maxExecutions, expiresAt }) {
    if (!name) throw new Error('Contract name is required');
    if (!conditions || conditions.length === 0) throw new Error('At least one condition is required');
    if (!actions || actions.length === 0) throw new Error('At least one action is required');

    // Validate conditions
    for (const c of conditions) {
      if (!c.field || !c.operator) throw new Error('Each condition needs field and operator');
      const validOps = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'exists'];
      if (!validOps.includes(c.operator)) throw new Error(`Invalid operator: ${c.operator}. Use: ${validOps.join(', ')}`);
    }

    // Validate actions
    for (const a of actions) {
      if (!a.type) throw new Error('Each action needs a type');
      if (a.type === 'transfer' && (!a.to || !a.amount || a.amount <= 0)) {
        throw new Error('Transfer action needs to and amount > 0');
      }
    }

    // Calculate total budget needed for transfer actions
    const totalBudget = actions
      .filter(a => a.type === 'transfer')
      .reduce((sum, a) => sum + a.amount, 0);
    const maxExec = maxExecutions || 1;
    const requiredBudget = totalBudget * maxExec;

    if (requiredBudget > 0) {
      const balance = this.dag.getBalance(wallet.address);
      if (balance < requiredBudget) {
        throw new Error(`Insufficient balance for contract budget. Need ${requiredBudget}, have ${balance}`);
      }
    }

    const contractId = this._generateId();

    // Record deployment on DAG
    const tx = wallet.sendData(tips, {
      _contract: 'deploy',
      contractId,
      name,
      description: description || '',
      conditions,
      actions,
      maxExecutions: maxExec,
      expiresAt: expiresAt || null,
      owner: wallet.address,
      budget: requiredBudget,
      deployedAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Lock budget in contract address
    if (requiredBudget > 0) {
      const contractAddr = `iotai_contract_${contractId}`;
      const tips2 = this.dag.selectTips();
      const lockTx = wallet.send(contractAddr, requiredBudget, tips2, {
        _contract: 'lock_budget',
        contractId,
        amount: requiredBudget,
      });
      const lockResult = this.dag.addTransaction(lockTx);
      if (!lockResult.success) throw new Error(`Budget lock failed: ${lockResult.error}`);
    }

    // Index contract
    const contract = {
      contractId,
      txId: tx.id,
      name,
      description: description || '',
      conditions,
      actions,
      maxExecutions: maxExec,
      executionCount: 0,
      owner: wallet.address,
      budget: requiredBudget,
      remainingBudget: requiredBudget,
      status: 'active',
      expiresAt: expiresAt || null,
      deployedAt: Date.now(),
    };

    this.contracts.set(contractId, contract);
    const ownerContracts = this.contractsByOwner.get(wallet.address) || [];
    ownerContracts.push(contract);
    this.contractsByOwner.set(wallet.address, ownerContracts);

    return { contractId, txId: tx.id, budget: requiredBudget };
  }

  /**
   * Evaluate a transaction against all active contracts
   * Called automatically when new transactions are added to DAG
   * @returns {Execution[]} List of triggered executions
   */
  evaluate(tx) {
    const triggered = [];

    for (const [, contract] of this.contracts) {
      if (contract.status !== 'active') continue;
      if (contract.executionCount >= contract.maxExecutions) {
        contract.status = 'completed';
        continue;
      }
      if (contract.expiresAt && Date.now() > contract.expiresAt) {
        contract.status = 'expired';
        continue;
      }

      // Don't trigger on own contract transactions
      if (tx.metadata?._contract) continue;

      // Check all conditions
      const match = this._evaluateConditions(contract.conditions, tx);
      if (!match) continue;

      // Execute actions
      const execution = this._executeActions(contract, tx);
      if (execution) {
        triggered.push(execution);
      }
    }

    return triggered;
  }

  /**
   * Pause a contract
   */
  pause(wallet, contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) throw new Error('Contract not found');
    if (contract.owner !== wallet.address) throw new Error('Only owner can pause');
    if (contract.status !== 'active') throw new Error('Contract is not active');
    contract.status = 'paused';
    return { contractId, status: 'paused' };
  }

  /**
   * Resume a paused contract
   */
  resume(wallet, contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) throw new Error('Contract not found');
    if (contract.owner !== wallet.address) throw new Error('Only owner can resume');
    if (contract.status !== 'paused') throw new Error('Contract is not paused');
    contract.status = 'active';
    return { contractId, status: 'active' };
  }

  /**
   * Cancel a contract and return remaining budget
   */
  cancel(wallet, contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) throw new Error('Contract not found');
    if (contract.owner !== wallet.address) throw new Error('Only owner can cancel');
    if (contract.status === 'cancelled') throw new Error('Already cancelled');

    // Return remaining budget
    if (contract.remainingBudget > 0) {
      const contractAddr = `iotai_contract_${contractId}`;
      const bal = this.dag.getBalance(contractAddr);
      if (bal > 0) {
        this.dag.balances.set(contractAddr, 0);
        const ownerBal = this.dag.balances.get(wallet.address) || 0;
        this.dag.balances.set(wallet.address, ownerBal + bal);
      }
    }

    contract.status = 'cancelled';
    contract.cancelledAt = Date.now();
    return { contractId, status: 'cancelled', refunded: contract.remainingBudget };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /** Get contract by ID */
  getContract(contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) return null;
    return {
      ...contract,
      executions: this.executions.get(contractId) || [],
    };
  }

  /** Get contracts by owner */
  getContractsByOwner(address) {
    return (this.contractsByOwner.get(address) || []).map(c => ({
      ...c,
      executions: (this.executions.get(c.contractId) || []).length,
    }));
  }

  /** Get all active contracts */
  getActiveContracts() {
    return [...this.contracts.values()].filter(c => c.status === 'active');
  }

  /** Get contract stats */
  getStats() {
    const all = [...this.contracts.values()];
    const totalExecutions = [...this.executions.values()].reduce((sum, e) => sum + e.length, 0);
    return {
      totalContracts: all.length,
      active: all.filter(c => c.status === 'active').length,
      paused: all.filter(c => c.status === 'paused').length,
      completed: all.filter(c => c.status === 'completed').length,
      cancelled: all.filter(c => c.status === 'cancelled').length,
      expired: all.filter(c => c.status === 'expired').length,
      totalExecutions,
    };
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  /** Evaluate conditions against a transaction */
  _evaluateConditions(conditions, tx) {
    for (const condition of conditions) {
      const value = this._getNestedValue(tx, condition.field);

      switch (condition.operator) {
        case '==':
          if (value !== condition.value) return false;
          break;
        case '!=':
          if (value === condition.value) return false;
          break;
        case '>':
          if (typeof value !== 'number' || value <= condition.value) return false;
          break;
        case '<':
          if (typeof value !== 'number' || value >= condition.value) return false;
          break;
        case '>=':
          if (typeof value !== 'number' || value < condition.value) return false;
          break;
        case '<=':
          if (typeof value !== 'number' || value > condition.value) return false;
          break;
        case 'contains':
          if (typeof value === 'string' && !value.includes(condition.value)) return false;
          else if (Array.isArray(value) && !value.includes(condition.value)) return false;
          else if (typeof value !== 'string' && !Array.isArray(value)) return false;
          break;
        case 'exists':
          if ((value === undefined || value === null) !== !condition.value) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  /** Execute contract actions */
  _executeActions(contract, triggerTx) {
    const contractAddr = `iotai_contract_${contract.contractId}`;
    const executionId = this._generateId();
    const results = [];

    for (const action of contract.actions) {
      try {
        switch (action.type) {
          case 'transfer': {
            // Resolve dynamic "to" (e.g., "{{from}}" refers to trigger tx sender)
            const to = this._resolveTemplate(action.to, triggerTx);
            const amount = action.amount;

            // Check contract has budget
            const bal = this.dag.getBalance(contractAddr);
            if (bal < amount) {
              results.push({ action: 'transfer', success: false, error: 'Insufficient contract budget' });
              continue;
            }

            // Execute transfer from contract
            this.dag.balances.set(contractAddr, bal - amount);
            const recipientBal = this.dag.balances.get(to) || 0;
            this.dag.balances.set(to, recipientBal + amount);
            contract.remainingBudget -= amount;

            results.push({ action: 'transfer', success: true, to, amount });
            break;
          }
          case 'store_data': {
            // Just log the execution - data is already on DAG via trigger tx
            results.push({ action: 'store_data', success: true, data: action.data || {} });
            break;
          }
          case 'notify': {
            results.push({ action: 'notify', success: true, message: action.message || 'Contract triggered' });
            break;
          }
          default:
            results.push({ action: action.type, success: false, error: 'Unknown action type' });
        }
      } catch (e) {
        results.push({ action: action.type, success: false, error: e.message });
      }
    }

    contract.executionCount++;
    if (contract.executionCount >= contract.maxExecutions) {
      contract.status = 'completed';
    }

    const execution = {
      executionId,
      contractId: contract.contractId,
      triggerTxId: triggerTx.id,
      results,
      executedAt: Date.now(),
    };

    const execs = this.executions.get(contract.contractId) || [];
    execs.push(execution);
    this.executions.set(contract.contractId, execs);

    return execution;
  }

  /** Get nested value from object using dot notation */
  _getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return current;
  }

  /** Resolve template variables like {{from}}, {{amount}} */
  _resolveTemplate(str, tx) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const val = this._getNestedValue(tx, path);
      return val !== undefined ? String(val) : '';
    });
  }

  _generateId() {
    return 'c_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
