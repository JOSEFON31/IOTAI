/**
 * IOTAI Multi-Currency Token System
 *
 * Agents can create custom tokens on the DAG (like ERC-20 for IOTAI).
 * Each token has: name, symbol, supply, decimals, and an owner.
 * Tokens are tracked as metadata on data transactions.
 *
 * Use cases:
 *   - Reputation tokens (non-transferable)
 *   - Service credits (redeemable)
 *   - Governance tokens (voting power)
 *   - Stablecoins backed by IOTAI escrow
 *
 * All state is immutably recorded on the DAG.
 */

export class TokenManager {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, Token>} tokenId -> token info */
    this.tokens = new Map();

    /** @type {Map<string, Map<string, number>>} tokenId -> (address -> balance) */
    this.balances = new Map();

    /** @type {Map<string, Transfer[]>} tokenId -> transfer history */
    this.transfers = new Map();

    /** @type {Map<string, Token[]>} ownerAddress -> tokens */
    this.tokensByOwner = new Map();

    // Rebuild from DAG
    this._rebuildIndex();
  }

  // ============================================================
  // TOKEN CREATION
  // ============================================================

  /**
   * Create a new custom token
   * @returns {{ tokenId: string, txId: string }}
   */
  createToken(wallet, tips, { name, symbol, totalSupply, decimals, transferable, description, metadata }) {
    if (!name || !symbol) throw new Error('name and symbol are required');
    if (!totalSupply || totalSupply <= 0) throw new Error('totalSupply must be > 0');
    if (symbol.length > 10) throw new Error('symbol max 10 characters');

    // Check symbol uniqueness
    for (const t of this.tokens.values()) {
      if (t.symbol.toUpperCase() === symbol.toUpperCase()) {
        throw new Error(`Symbol ${symbol} already exists`);
      }
    }

    const tokenId = 'tok_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    const tx = wallet.sendData(tips, {
      _token: 'create',
      tokenId,
      name,
      symbol: symbol.toUpperCase(),
      totalSupply,
      decimals: decimals || 0,
      transferable: transferable !== false, // default true
      description: description || '',
      metadata: metadata || {},
      creator: wallet.address,
      createdAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Index token
    const token = {
      tokenId,
      txId: tx.id,
      name,
      symbol: symbol.toUpperCase(),
      totalSupply,
      decimals: decimals || 0,
      transferable: transferable !== false,
      description: description || '',
      metadata: metadata || {},
      creator: wallet.address,
      circulatingSupply: totalSupply,
      holders: 1,
      totalTransfers: 0,
      createdAt: Date.now(),
    };

    this.tokens.set(tokenId, token);

    // Give full supply to creator
    const balMap = new Map();
    balMap.set(wallet.address, totalSupply);
    this.balances.set(tokenId, balMap);
    this.transfers.set(tokenId, []);

    const ownerTokens = this.tokensByOwner.get(wallet.address) || [];
    ownerTokens.push(token);
    this.tokensByOwner.set(wallet.address, ownerTokens);

    return { tokenId, txId: tx.id, symbol: token.symbol };
  }

  // ============================================================
  // TOKEN TRANSFERS
  // ============================================================

  /**
   * Transfer custom tokens between addresses
   * @returns {{ txId: string }}
   */
  transfer(wallet, tips, { tokenId, to, amount, memo }) {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error('Token not found');
    if (!token.transferable) throw new Error(`${token.symbol} is non-transferable`);
    if (!to || !amount || amount <= 0) throw new Error('to and amount > 0 required');
    if (wallet.address === to) throw new Error('Cannot transfer to yourself');

    const balMap = this.balances.get(tokenId);
    const senderBal = balMap?.get(wallet.address) || 0;
    if (senderBal < amount) {
      throw new Error(`Insufficient ${token.symbol} balance. Have ${senderBal}, need ${amount}`);
    }

    const tx = wallet.sendData(tips, {
      _token: 'transfer',
      tokenId,
      symbol: token.symbol,
      from: wallet.address,
      to,
      amount,
      memo: memo || '',
      transferredAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Update balances
    balMap.set(wallet.address, senderBal - amount);
    const recipientBal = balMap.get(to) || 0;
    balMap.set(to, recipientBal + amount);

    // Remove zero-balance entries
    if (balMap.get(wallet.address) === 0) balMap.delete(wallet.address);

    // Update stats
    token.totalTransfers++;
    token.holders = balMap.size;

    // Record transfer
    const transfers = this.transfers.get(tokenId);
    transfers.push({
      txId: tx.id,
      from: wallet.address,
      to,
      amount,
      memo: memo || '',
      timestamp: Date.now(),
    });

    return { txId: tx.id, symbol: token.symbol, from: wallet.address, to, amount };
  }

  /**
   * Mint additional tokens (creator only)
   */
  mint(wallet, tips, { tokenId, amount, to }) {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error('Token not found');
    if (token.creator !== wallet.address) throw new Error('Only creator can mint');
    if (!amount || amount <= 0) throw new Error('amount must be > 0');

    const recipient = to || wallet.address;

    const tx = wallet.sendData(tips, {
      _token: 'mint',
      tokenId,
      symbol: token.symbol,
      to: recipient,
      amount,
      mintedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Update balances
    const balMap = this.balances.get(tokenId);
    const currentBal = balMap.get(recipient) || 0;
    balMap.set(recipient, currentBal + amount);

    token.totalSupply += amount;
    token.circulatingSupply += amount;
    token.holders = balMap.size;

    return { txId: tx.id, symbol: token.symbol, minted: amount, to: recipient };
  }

  /**
   * Burn tokens (reduce supply)
   */
  burn(wallet, tips, { tokenId, amount }) {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error('Token not found');
    if (!amount || amount <= 0) throw new Error('amount must be > 0');

    const balMap = this.balances.get(tokenId);
    const senderBal = balMap?.get(wallet.address) || 0;
    if (senderBal < amount) {
      throw new Error(`Insufficient ${token.symbol} balance to burn`);
    }

    const tx = wallet.sendData(tips, {
      _token: 'burn',
      tokenId,
      symbol: token.symbol,
      burner: wallet.address,
      amount,
      burnedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    balMap.set(wallet.address, senderBal - amount);
    if (balMap.get(wallet.address) === 0) balMap.delete(wallet.address);

    token.totalSupply -= amount;
    token.circulatingSupply -= amount;
    token.holders = balMap.size;

    return { txId: tx.id, symbol: token.symbol, burned: amount };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /** Get token info */
  getToken(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return null;
    return { ...token };
  }

  /** Find token by symbol */
  getTokenBySymbol(symbol) {
    for (const t of this.tokens.values()) {
      if (t.symbol === symbol.toUpperCase()) return { ...t };
    }
    return null;
  }

  /** Get all tokens */
  listTokens({ creator, sortBy, limit } = {}) {
    let results = [...this.tokens.values()];
    if (creator) results = results.filter(t => t.creator === creator);
    if (sortBy === 'holders') results.sort((a, b) => b.holders - a.holders);
    else if (sortBy === 'transfers') results.sort((a, b) => b.totalTransfers - a.totalTransfers);
    else results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, limit || 50);
  }

  /** Get token balance for an address */
  getBalance(tokenId, address) {
    const balMap = this.balances.get(tokenId);
    return balMap?.get(address) || 0;
  }

  /** Get all token balances for an address */
  getBalances(address) {
    const result = [];
    for (const [tokenId, balMap] of this.balances) {
      const bal = balMap.get(address);
      if (bal && bal > 0) {
        const token = this.tokens.get(tokenId);
        result.push({
          tokenId,
          symbol: token.symbol,
          name: token.name,
          balance: bal,
          decimals: token.decimals,
        });
      }
    }
    return result;
  }

  /** Get token holders */
  getHolders(tokenId, limit = 20) {
    const balMap = this.balances.get(tokenId);
    if (!balMap) return [];
    return [...balMap.entries()]
      .filter(([, bal]) => bal > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address, balance]) => ({ address, balance }));
  }

  /** Get transfer history for a token */
  getTransfers(tokenId, limit = 50) {
    return (this.transfers.get(tokenId) || [])
      .slice(-limit)
      .reverse();
  }

  /** Get stats */
  getStats() {
    let totalTransfers = 0;
    for (const t of this.tokens.values()) totalTransfers += t.totalTransfers;
    return {
      totalTokens: this.tokens.size,
      transferableTokens: [...this.tokens.values()].filter(t => t.transferable).length,
      totalTransfers,
    };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  _rebuildIndex() {
    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._token)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._token) {
        case 'create': this._indexCreate(tx); break;
        case 'transfer': this._indexTransfer(tx); break;
        case 'mint': this._indexMint(tx); break;
        case 'burn': this._indexBurn(tx); break;
      }
    }

    if (this.tokens.size > 0) {
      console.log(`[Tokens] Indexed ${this.tokens.size} tokens`);
    }
  }

  _indexCreate(tx) {
    const m = tx.metadata;
    const token = {
      tokenId: m.tokenId,
      txId: tx.id,
      name: m.name,
      symbol: m.symbol,
      totalSupply: m.totalSupply,
      decimals: m.decimals || 0,
      transferable: m.transferable !== false,
      description: m.description || '',
      metadata: m.metadata || {},
      creator: m.creator || tx.from,
      circulatingSupply: m.totalSupply,
      holders: 1,
      totalTransfers: 0,
      createdAt: m.createdAt || tx.timestamp,
    };
    this.tokens.set(m.tokenId, token);

    const balMap = new Map();
    balMap.set(token.creator, m.totalSupply);
    this.balances.set(m.tokenId, balMap);
    this.transfers.set(m.tokenId, []);

    const ownerTokens = this.tokensByOwner.get(token.creator) || [];
    ownerTokens.push(token);
    this.tokensByOwner.set(token.creator, ownerTokens);
  }

  _indexTransfer(tx) {
    const m = tx.metadata;
    const balMap = this.balances.get(m.tokenId);
    if (!balMap) return;

    const fromBal = balMap.get(m.from) || 0;
    balMap.set(m.from, fromBal - m.amount);
    if (balMap.get(m.from) <= 0) balMap.delete(m.from);

    const toBal = balMap.get(m.to) || 0;
    balMap.set(m.to, toBal + m.amount);

    const token = this.tokens.get(m.tokenId);
    if (token) {
      token.totalTransfers++;
      token.holders = balMap.size;
    }

    const transfers = this.transfers.get(m.tokenId) || [];
    transfers.push({ txId: tx.id, from: m.from, to: m.to, amount: m.amount, memo: m.memo, timestamp: m.transferredAt || tx.timestamp });
  }

  _indexMint(tx) {
    const m = tx.metadata;
    const balMap = this.balances.get(m.tokenId);
    if (!balMap) return;

    const toBal = balMap.get(m.to) || 0;
    balMap.set(m.to, toBal + m.amount);

    const token = this.tokens.get(m.tokenId);
    if (token) {
      token.totalSupply += m.amount;
      token.circulatingSupply += m.amount;
      token.holders = balMap.size;
    }
  }

  _indexBurn(tx) {
    const m = tx.metadata;
    const balMap = this.balances.get(m.tokenId);
    if (!balMap) return;

    const burnerBal = balMap.get(m.burner) || 0;
    balMap.set(m.burner, burnerBal - m.amount);
    if (balMap.get(m.burner) <= 0) balMap.delete(m.burner);

    const token = this.tokens.get(m.tokenId);
    if (token) {
      token.totalSupply -= m.amount;
      token.circulatingSupply -= m.amount;
      token.holders = balMap.size;
    }
  }
}
