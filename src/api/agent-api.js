/**
 * IOTAI Agent API
 *
 * REST API designed specifically for AI agents to:
 * - Create wallets and manage keys
 * - Send/receive IOTAI tokens
 * - Pay other agents (M2M payments)
 * - Store data on the DAG
 * - Query balances and transaction history
 *
 * This API uses ephemeral auth tokens so AI agents can authenticate
 * without long-lived credentials.
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { Wallet } from '../wallet/wallet.js';
import { hash, generateNonce } from '../core/crypto.js';
import { Faucet } from '../core/faucet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCS_DIR = resolve(__dirname, '../../docs');

export class AgentAPI {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   * @param {import('../network/node.js').IOTAINode} params.node
   * @param {import('../consensus/validator.js').Validator} params.validator
   * @param {number} [params.apiPort=8080]
   */
  constructor({ dag, node, validator, apiPort = 8080 }) {
    this.dag = dag;
    this.node = node;
    this.validator = validator;
    this.faucet = new Faucet(dag);
    this.apiPort = apiPort;
    this.server = null;

    // Ephemeral token store: token -> { wallet, expiresAt }
    /** @type {Map<string, { wallet: Wallet, expiresAt: number }>} */
    this.sessions = new Map();

    // SSE clients for real-time events
    /** @type {Set<import('http').ServerResponse>} */
    this.sseClients = new Set();

    // Token TTL: 1 hour
    this.tokenTTL = 60 * 60 * 1000;
  }

  /**
   * Start the API server
   */
  async start() {
    this.server = createServer(async (req, res) => {
      // CORS for agent access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        const url = new URL(req.url, `http://localhost:${this.apiPort}`);

        // SSE endpoint (special handling - keeps connection open)
        if (req.method === 'GET' && url.pathname === '/api/v1/events') {
          return this._handleSSE(req, res);
        }

        // Serve docs site for non-API routes
        if (!url.pathname.startsWith('/api/')) {
          return this._serveStatic(req, res, url.pathname);
        }

        const body = await this._readBody(req);
        const result = await this._handleRequest(req, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return new Promise((resolve) => {
      this.server.listen(this.apiPort, () => {
        console.log(`[IOTAI API] Agent API running on http://localhost:${this.apiPort}`);
        this._setupSSEEvents();
        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }

  // ============================================================
  // REQUEST ROUTING
  // ============================================================

  async _handleRequest(req, body) {
    const url = new URL(req.url, `http://localhost:${this.apiPort}`);
    const path = url.pathname;
    const method = req.method;

    // Public endpoints (no auth needed)
    if (method === 'POST' && path === '/api/v1/wallet/create') {
      return this._createWallet(body);
    }
    if (method === 'POST' && path === '/api/v1/auth/token') {
      return this._createToken(body);
    }
    if (method === 'GET' && path === '/api/v1/network/stats') {
      return this._getNetworkStats();
    }
    if (method === 'GET' && path === '/api/v1/network/peers') {
      return this._getPeers();
    }
    if (method === 'GET' && path === '/api/v1/faucet/status') {
      return { status: 200, data: this.faucet.getStatus() };
    }
    if (method === 'POST' && path === '/api/v1/faucet/start') {
      return this._faucetStart();
    }
    if (method === 'POST' && path === '/api/v1/faucet/claim') {
      return this._faucetClaim(body, req);
    }

    // Data query endpoints (public)
    if (method === 'GET' && path === '/api/v1/data/search') {
      return this._searchData(url.searchParams);
    }
    if (method === 'GET' && path.startsWith('/api/v1/data/')) {
      const txId = path.split('/api/v1/data/')[1];
      if (txId) return this._getDataTransaction(txId);
    }

    // Authenticated endpoints
    const session = this._authenticate(req);
    if (!session) {
      return { status: 401, data: { error: 'Invalid or expired token' } };
    }

    if (method === 'POST' && path === '/api/v1/transfer') {
      return this._transfer(session, body);
    }
    if (method === 'POST' && path === '/api/v1/data') {
      return this._storeData(session, body);
    }
    if (method === 'GET' && path === '/api/v1/balance') {
      return this._getBalance(session);
    }
    if (method === 'GET' && path === '/api/v1/history') {
      return this._getHistory(session);
    }
    if (method === 'GET' && path.startsWith('/api/v1/tx/')) {
      const txId = path.split('/api/v1/tx/')[1];
      return this._getTransaction(txId);
    }

    return { status: 404, data: { error: 'Not found' } };
  }

  // ============================================================
  // API ENDPOINTS
  // ============================================================

  /**
   * POST /api/v1/wallet/create
   * Create a new wallet for an AI agent
   */
  _createWallet(body) {
    const wallet = body?.passphrase
      ? new Wallet({ passphrase: body.passphrase })
      : new Wallet();

    const info = wallet.getInfo();

    // Auto-create a session for convenience
    const token = this._generateToken();
    this.sessions.set(token, {
      wallet,
      expiresAt: Date.now() + this.tokenTTL,
    });

    return {
      status: 201,
      data: {
        address: info.address,
        publicKey: info.publicKey,
        token,
        expiresIn: this.tokenTTL,
        message: 'Wallet created. Use the token for authenticated requests.',
      },
    };
  }

  /**
   * POST /api/v1/auth/token
   * Generate a new ephemeral token for an existing wallet
   */
  _createToken(body) {
    if (!body?.passphrase) {
      return { status: 400, data: { error: 'Passphrase required' } };
    }

    const wallet = new Wallet({ passphrase: body.passphrase });
    const token = this._generateToken();

    this.sessions.set(token, {
      wallet,
      expiresAt: Date.now() + this.tokenTTL,
    });

    return {
      status: 200,
      data: {
        address: wallet.address,
        token,
        expiresIn: this.tokenTTL,
      },
    };
  }

  /**
   * POST /api/v1/transfer
   * Send IOTAI to another address (agent-to-agent payment)
   */
  _transfer(session, body) {
    if (!body?.to || !body?.amount) {
      return { status: 400, data: { error: 'Fields required: to, amount' } };
    }

    const { wallet } = session;
    const tips = this.dag.selectTips();

    const tx = wallet.send(body.to, body.amount, tips, body.metadata || null);

    // Validate with consensus
    const validation = this.validator.validate(tx);
    if (!validation.valid) {
      return { status: 400, data: { error: validation.error } };
    }

    // Add to local DAG
    const result = this.dag.addTransaction(tx);
    if (!result.success) {
      return { status: 400, data: { error: result.error } };
    }

    // Broadcast to network and SSE clients
    this.node.broadcastTransaction(tx).catch(console.error);
    this._broadcastSSE('transaction', {
      id: tx.id, type: tx.type, from: tx.from, to: tx.to,
      amount: tx.amount, timestamp: tx.timestamp,
    });

    return {
      status: 200,
      data: {
        txId: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        status: 'pending',
        message: 'Transaction broadcast to network',
      },
    };
  }

  /**
   * POST /api/v1/data
   * Store arbitrary data on the DAG (AI agent messages, requests, etc.)
   */
  _storeData(session, body) {
    if (!body?.metadata) {
      return { status: 400, data: { error: 'Field required: metadata' } };
    }

    const { wallet } = session;
    const tips = this.dag.selectTips();

    const tx = wallet.sendData(tips, body.metadata);

    const validation = this.validator.validate(tx);
    if (!validation.valid) {
      return { status: 400, data: { error: validation.error } };
    }

    const result = this.dag.addTransaction(tx);
    if (!result.success) {
      return { status: 400, data: { error: result.error } };
    }

    this.node.broadcastTransaction(tx).catch(console.error);
    this._broadcastSSE('transaction', {
      id: tx.id, type: tx.type, from: tx.from,
      timestamp: tx.timestamp, metadata: tx.metadata,
    });

    return {
      status: 200,
      data: {
        txId: tx.id,
        metadata: tx.metadata,
        status: 'stored',
      },
    };
  }

  /**
   * GET /api/v1/balance
   */
  _getBalance(session) {
    const balance = this.dag.getBalance(session.wallet.address);
    return {
      status: 200,
      data: {
        address: session.wallet.address,
        balance,
        unit: 'IOTAI',
      },
    };
  }

  /**
   * GET /api/v1/history
   */
  _getHistory(session) {
    const history = this.dag.getHistory(session.wallet.address);
    return {
      status: 200,
      data: {
        address: session.wallet.address,
        transactions: history.map((tx) => ({
          id: tx.id,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          timestamp: tx.timestamp,
          confirmed: this.validator.isConfirmed(tx.id),
        })),
      },
    };
  }

  /**
   * GET /api/v1/tx/:id
   */
  _getTransaction(txId) {
    const tx = this.dag.getTransaction(txId);
    if (!tx) {
      return { status: 404, data: { error: 'Transaction not found' } };
    }

    return {
      status: 200,
      data: {
        ...tx,
        confirmationStatus: this.validator.getConfirmationStatus(txId),
      },
    };
  }

  /**
   * GET /api/v1/network/stats
   */
  _getNetworkStats() {
    return {
      status: 200,
      data: {
        ...this.dag.getStats(),
        connectedPeers: this.node.getPeerCount(),
        minimumPeersMet: this.node.hasMinimumPeers(),
      },
    };
  }

  /**
   * GET /api/v1/network/peers
   */
  _getPeers() {
    return {
      status: 200,
      data: {
        count: this.node.getPeerCount(),
        peers: Array.from(this.node.peers.entries()).map(([id, info]) => ({
          id: id.substring(0, 12) + '...',
          lastSeen: info.lastSeen,
        })),
      },
    };
  }

  // ============================================================
  // FAUCET ENDPOINTS (Proof of Personhood)
  // ============================================================

  /**
   * POST /api/v1/faucet/start
   * Begin facial verification - returns a liveness challenge
   */
  _faucetStart() {
    try {
      const challenge = this.faucet.startVerification();
      return { status: 200, data: challenge };
    } catch (err) {
      return { status: 400, data: { error: err.message } };
    }
  }

  /**
   * POST /api/v1/faucet/claim
   * Submit face verification and claim tokens
   * Body: { challengeId, faceEmbedding, livenessPass, address }
   */
  async _faucetClaim(body, req) {
    if (!body?.challengeId || !body?.faceEmbedding || !body?.address) {
      return {
        status: 400,
        data: { error: 'Required: challengeId, faceEmbedding (array), address' },
      };
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    const result = await this.faucet.claimTokens({
      challengeId: body.challengeId,
      faceEmbedding: body.faceEmbedding,
      livenessPass: body.livenessPass ?? false,
      address: body.address,
      ip,
    });

    return {
      status: result.success ? 200 : 400,
      data: result,
    };
  }

  // ============================================================
  // DATA QUERY ENDPOINTS
  // ============================================================

  /**
   * GET /api/v1/data/search?from=addr&key=k&value=v&since=ts&until=ts&limit=N&offset=N&q=text
   * Search data transactions on the DAG
   */
  _searchData(params) {
    const q = params.get('q');

    // Full-text search mode
    if (q) {
      const limit = parseInt(params.get('limit') || '20', 10);
      const results = this.dag.searchData(q, limit);
      return {
        status: 200,
        data: {
          query: q,
          results: results.map(tx => ({
            id: tx.id,
            from: tx.from,
            metadata: tx.metadata,
            timestamp: tx.timestamp,
          })),
          total: results.length,
        },
      };
    }

    // Structured filter mode
    const filters = {};
    if (params.get('from')) filters.from = params.get('from');
    if (params.get('key')) filters.key = params.get('key');
    if (params.get('value')) filters.value = params.get('value');
    if (params.get('since')) filters.since = parseInt(params.get('since'), 10);
    if (params.get('until')) filters.until = parseInt(params.get('until'), 10);
    if (params.get('limit')) filters.limit = parseInt(params.get('limit'), 10);
    if (params.get('offset')) filters.offset = parseInt(params.get('offset'), 10);

    const { transactions, total } = this.dag.queryData(filters);

    return {
      status: 200,
      data: {
        filters,
        results: transactions.map(tx => ({
          id: tx.id,
          from: tx.from,
          metadata: tx.metadata,
          timestamp: tx.timestamp,
        })),
        total,
        returned: transactions.length,
      },
    };
  }

  /**
   * GET /api/v1/data/:txId
   * Get a specific data transaction
   */
  _getDataTransaction(txId) {
    const tx = this.dag.getTransaction(txId);
    if (!tx) {
      return { status: 404, data: { error: 'Transaction not found' } };
    }
    if (tx.type !== 'data') {
      return { status: 400, data: { error: 'Transaction is not a data transaction' } };
    }
    return {
      status: 200,
      data: {
        id: tx.id,
        from: tx.from,
        metadata: tx.metadata,
        timestamp: tx.timestamp,
        parents: tx.parents,
        confirmationStatus: this.validator.getConfirmationStatus(txId),
      },
    };
  }

  // ============================================================
  // SERVER-SENT EVENTS (Real-time)
  // ============================================================

  /**
   * GET /api/v1/events
   * SSE stream for real-time notifications
   * Events: transaction, confirmation, peer:connect, peer:disconnect
   */
  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to IOTAI event stream', timestamp: Date.now() })}\n\n`);

    this.sseClients.add(res);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30000);

    req.on('close', () => {
      this.sseClients.delete(res);
      clearInterval(heartbeat);
    });
  }

  /**
   * Broadcast an SSE event to all connected clients
   * @param {string} event - event name
   * @param {object} data - event payload
   */
  _broadcastSSE(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Wire up DAG/node events to SSE stream
   */
  _setupSSEEvents() {
    // Transaction received from P2P network
    this.node.on('transaction:received', (tx) => {
      this._broadcastSSE('transaction', {
        id: tx.id,
        type: tx.type,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        timestamp: tx.timestamp,
        metadata: tx.metadata || null,
      });
    });

    // DAG sync complete
    this.node.on('sync:complete', ({ peerId, imported }) => {
      this._broadcastSSE('sync', {
        peerId: peerId.substring(0, 12) + '...',
        imported,
        totalTransactions: this.dag.transactions.size,
      });
    });

    // Peer connected
    this.node.on('peer:connected', ({ peerId }) => {
      this._broadcastSSE('peer:connect', {
        peerId: peerId.substring(0, 12) + '...',
        totalPeers: this.node.getPeerCount(),
      });
    });

    // Peer disconnected
    this.node.on('peer:disconnected', ({ peerId }) => {
      this._broadcastSSE('peer:disconnect', {
        peerId: peerId.substring(0, 12) + '...',
        totalPeers: this.node.getPeerCount(),
      });
    });
  }

  // ============================================================
  // AUTH HELPERS
  // ============================================================

  _authenticate(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.substring(7);
    const session = this.sessions.get(token);

    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    return session;
  }

  _generateToken() {
    const nonce = generateNonce();
    return hash(nonce + Date.now().toString());
  }

  async _readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  /**
   * Serve static files from docs/ directory
   */
  _serveStatic(req, res, pathname) {
    const MIME = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    let filePath = pathname === '/' ? '/index.html' : pathname;
    // Sanitize path to prevent directory traversal
    filePath = filePath.replace(/\.\./g, '');
    const fullPath = resolve(DOCS_DIR, '.' + filePath);

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(content);
    } catch {
      // If file not found, serve index.html (SPA fallback)
      try {
        const content = readFileSync(resolve(DOCS_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    }
  }
}
