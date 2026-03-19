/**
 * IOTAI JavaScript SDK
 *
 * 3-line integration for AI agents:
 *   const iotai = new IOTAI('http://localhost:8080');
 *   await iotai.createWallet();
 *   await iotai.send('iotai_recipient...', 100);
 */

export class IOTAI {
  /**
   * @param {string} baseUrl - IOTAI node URL (e.g. 'http://localhost:8080')
   * @param {object} [options]
   * @param {string} [options.token] - Pre-existing auth token
   * @param {string} [options.mnemonic] - Restore wallet on init
   * @param {number} [options.timeout] - Request timeout in ms (default 10000)
   */
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = options.token || null;
    this.address = null;
    this.mnemonic = null;
    this.publicKey = null;
    this.timeout = options.timeout || 10000;
    this._ws = null;
    this._wsListeners = new Map();

    // Auto-restore if mnemonic provided
    if (options.mnemonic) {
      this._autoRestore = this.restoreWallet(options.mnemonic);
    }
  }

  // ============================================================
  // WALLET
  // ============================================================

  /** Create a new wallet and authenticate */
  async createWallet() {
    const res = await this._post('/api/v1/wallet/create', {});
    this.address = res.address;
    this.mnemonic = res.mnemonic;
    this.publicKey = res.publicKey;

    // Auto-authenticate
    await this.authenticate(res.mnemonic);
    return { address: res.address, mnemonic: res.mnemonic };
  }

  /** Restore wallet from mnemonic and authenticate */
  async restoreWallet(mnemonic) {
    const res = await this._post('/api/v1/wallet/restore', { mnemonic });
    this.address = res.address;
    this.mnemonic = mnemonic;
    this.publicKey = res.publicKey;

    await this.authenticate(mnemonic);
    return { address: res.address };
  }

  /** Authenticate with the node */
  async authenticate(mnemonic) {
    const res = await this._post('/api/v1/auth/token', { mnemonic: mnemonic || this.mnemonic });
    this.token = res.token;
    this.address = res.address;
    return { token: res.token, address: res.address, expiresIn: res.expiresIn };
  }

  // ============================================================
  // TRANSACTIONS
  // ============================================================

  /** Send IOTAI tokens */
  async send(to, amount, metadata = null) {
    await this._ensureAuth();
    const body = { to, amount };
    if (metadata) body.metadata = metadata;
    return this._post('/api/v1/transfer', body);
  }

  /** Store data on the DAG */
  async storeData(metadata) {
    await this._ensureAuth();
    return this._post('/api/v1/data', { metadata });
  }

  /** Get current balance */
  async getBalance() {
    await this._ensureAuth();
    const res = await this._get('/api/v1/balance');
    return res.balance;
  }

  /** Get transaction history */
  async getHistory() {
    await this._ensureAuth();
    return this._get('/api/v1/history');
  }

  /** Get transaction details */
  async getTransaction(txId) {
    await this._ensureAuth();
    return this._get(`/api/v1/tx/${txId}`);
  }

  /** Calculate fee for amount */
  async calculateFee(amount) {
    const res = await this._get(`/api/v1/fees/calculate?amount=${amount}`);
    return res.fee;
  }

  // ============================================================
  // MARKETPLACE
  // ============================================================

  /** Browse marketplace listings */
  async browseListings(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    const url = params ? `/api/v1/marketplace/listings?${params}` : '/api/v1/marketplace/listings';
    return this._get(url);
  }

  /** Get listing details */
  async getListing(listingId) {
    return this._get(`/api/v1/marketplace/listing/${listingId}`);
  }

  /** Create a service listing */
  async createListing({ title, description, price, category, tags, deliveryTime }) {
    await this._ensureAuth();
    return this._post('/api/v1/marketplace/list', { title, description, price, category, tags, deliveryTime });
  }

  /** Purchase a listing (with escrow by default) */
  async purchase(listingId, { message, useEscrow = true } = {}) {
    await this._ensureAuth();
    return this._post('/api/v1/marketplace/buy', { listingId, message, useEscrow });
  }

  /** Confirm delivery (release escrow to seller) */
  async confirmDelivery(purchaseId) {
    await this._ensureAuth();
    return this._post('/api/v1/marketplace/escrow/confirm', { purchaseId });
  }

  /** Request refund */
  async requestRefund(purchaseId, reason) {
    await this._ensureAuth();
    return this._post('/api/v1/marketplace/escrow/refund-request', { purchaseId, reason });
  }

  /** Leave a review */
  async review(purchaseId, rating, comment) {
    await this._ensureAuth();
    return this._post('/api/v1/marketplace/review', { purchaseId, rating, comment });
  }

  /** Get seller profile */
  async getSellerProfile(address) {
    return this._get(`/api/v1/marketplace/seller/${address}`);
  }

  /** Get my purchases */
  async getMyPurchases() {
    await this._ensureAuth();
    return this._get('/api/v1/marketplace/my/purchases');
  }

  /** Get my listings */
  async getMyListings() {
    await this._ensureAuth();
    return this._get('/api/v1/marketplace/my/listings');
  }

  // ============================================================
  // SMART CONTRACTS
  // ============================================================

  /** Deploy a smart contract */
  async deployContract({ name, conditions, actions, maxExecutions }) {
    await this._ensureAuth();
    return this._post('/api/v1/contracts/deploy', { name, conditions, actions, maxExecutions });
  }

  /** Get contract status */
  async getContract(contractId) {
    await this._ensureAuth();
    return this._get(`/api/v1/contracts/${contractId}`);
  }

  /** Get my contracts */
  async getMyContracts() {
    await this._ensureAuth();
    return this._get('/api/v1/contracts/my');
  }

  // ============================================================
  // ORCHESTRATION
  // ============================================================

  /** Create a task pipeline */
  async createPipeline({ name, tasks, budget }) {
    await this._ensureAuth();
    return this._post('/api/v1/orchestrator/pipeline', { name, tasks, budget });
  }

  /** Get pipeline status */
  async getPipeline(pipelineId) {
    await this._ensureAuth();
    return this._get(`/api/v1/orchestrator/pipeline/${pipelineId}`);
  }

  /** Register as a worker agent */
  async registerWorker(capabilities) {
    await this._ensureAuth();
    return this._post('/api/v1/orchestrator/worker/register', { capabilities });
  }

  /** Claim a task from the queue */
  async claimTask(pipelineId, taskIndex) {
    await this._ensureAuth();
    return this._post('/api/v1/orchestrator/task/claim', { pipelineId, taskIndex });
  }

  /** Submit task result */
  async submitResult(pipelineId, taskIndex, result) {
    await this._ensureAuth();
    return this._post('/api/v1/orchestrator/task/submit', { pipelineId, taskIndex, result });
  }

  // ============================================================
  // NETWORK
  // ============================================================

  /** Get network statistics */
  async getNetworkStats() {
    return this._get('/api/v1/network/stats');
  }

  /** Get node info */
  async getNodeInfo() {
    return this._get('/api/v1/network/node-info');
  }

  /** Get address info */
  async getAddressInfo(address) {
    return this._get(`/api/v1/address/${address}`);
  }

  // ============================================================
  // WEBSOCKET
  // ============================================================

  /** Connect to WebSocket for real-time events */
  async connectWebSocket(channels = ['transactions']) {
    if (this._ws) return;

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';

    // Works in both Node.js and browser
    let WS;
    if (typeof WebSocket !== 'undefined') {
      WS = WebSocket;
    } else {
      WS = (await import('ws')).default;
    }

    return new Promise((resolve, reject) => {
      this._ws = new WS(wsUrl);

      this._ws.onopen = () => {
        if (this.token) {
          this._ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        }
        this._ws.send(JSON.stringify({ type: 'subscribe', channels }));
        resolve();
      };

      this._ws.onmessage = (event) => {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        const listeners = this._wsListeners.get(msg.type) || [];
        for (const fn of listeners) fn(msg.data || msg);
      };

      this._ws.onerror = (err) => reject(err);
      this._ws.onclose = () => { this._ws = null; };
    });
  }

  /** Listen to WebSocket events */
  on(event, callback) {
    if (!this._wsListeners.has(event)) this._wsListeners.set(event, []);
    this._wsListeners.get(event).push(callback);
    return this;
  }

  /** Disconnect WebSocket */
  disconnectWebSocket() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  // ============================================================
  // INTERNALS
  // ============================================================

  async _ensureAuth() {
    if (this._autoRestore) await this._autoRestore;
    if (!this.token) throw new Error('Not authenticated. Call createWallet() or restoreWallet() first.');
  }

  async _get(path) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers, signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _post(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default IOTAI;
