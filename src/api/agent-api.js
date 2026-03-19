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

    // Broadcast to network
    this.node.broadcastTransaction(tx).catch(console.error);

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
