/**
 * IOTAI WebSocket API
 *
 * Bidirectional real-time communication for AI agents.
 * Supports: authentication, channel subscriptions, live events,
 * and command execution (transfer, balance, data queries).
 *
 * Protocol:
 *   Client -> Server (JSON messages):
 *     { type: "auth", token: "..." }
 *     { type: "subscribe", channels: ["transactions", "peers", ...] }
 *     { type: "unsubscribe", channels: ["transactions"] }
 *     { type: "transfer", to: "addr", amount: 100 }
 *     { type: "balance" }
 *     { type: "history" }
 *     { type: "stats" }
 *     { type: "ping" }
 *
 *   Server -> Client (JSON messages):
 *     { event: "welcome", data: { ... } }
 *     { event: "authenticated", data: { address, balance } }
 *     { event: "subscribed", data: { channels } }
 *     { event: "transaction", data: { id, type, from, to, amount, ... } }
 *     { event: "confirmation", data: { txId, weight, confirmed } }
 *     { event: "peer:connect", data: { ... } }
 *     { event: "peer:disconnect", data: { ... } }
 *     { event: "error", data: { message } }
 *     { event: "pong", data: { timestamp } }
 */

import { WebSocketServer } from 'ws';

const HEARTBEAT_INTERVAL = 30000;
const ALL_CHANNELS = ['transactions', 'confirmations', 'peers', 'sync', 'data'];

export class IOTAIWebSocket {
  /**
   * @param {object} params
   * @param {import('http').Server} params.server - HTTP server to attach to
   * @param {import('../core/dag.js').DAG} params.dag
   * @param {object} params.sessions - Map<string, { wallet, expiresAt }>
   * @param {object} [params.node] - P2P node (optional, for event wiring)
   * @param {object} [params.validator] - Consensus validator (optional)
   * @param {Function} [params.verifyTx] - Transaction verification function
   */
  constructor({ server, dag, sessions, node, validator, verifyTx }) {
    this.dag = dag;
    this.sessions = sessions;
    this.node = node;
    this.validator = validator;
    this.verifyTx = verifyTx;

    /** @type {Map<import('ws').WebSocket, ClientState>} */
    this.clients = new Map();

    this.wss = new WebSocketServer({ server, path: '/ws' });
    this._setup();
    this._wireEvents();

    console.log('[WebSocket] Server attached at /ws');
  }

  // ============================================================
  // SETUP
  // ============================================================

  _setup() {
    this.wss.on('connection', (ws, req) => {
      const clientState = {
        ws,
        authenticated: false,
        wallet: null,
        channels: new Set(['transactions']), // default subscription
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
        connectedAt: Date.now(),
      };

      this.clients.set(ws, clientState);

      // Send welcome
      this._send(ws, 'welcome', {
        message: 'Connected to IOTAI WebSocket API',
        version: '1.0.0',
        channels: ALL_CHANNELS,
        timestamp: Date.now(),
      });

      // Heartbeat
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });

      // Handle messages
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(ws, clientState, msg);
        } catch {
          this._send(ws, 'error', { message: 'Invalid JSON' });
        }
      });

      // Cleanup on close
      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // Heartbeat interval - terminate dead connections
    this._heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          this.clients.delete(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_INTERVAL);
  }

  // ============================================================
  // MESSAGE HANDLER
  // ============================================================

  _handleMessage(ws, state, msg) {
    switch (msg.type) {
      case 'auth':
        return this._handleAuth(ws, state, msg);
      case 'subscribe':
        return this._handleSubscribe(ws, state, msg);
      case 'unsubscribe':
        return this._handleUnsubscribe(ws, state, msg);
      case 'transfer':
        return this._handleTransfer(ws, state, msg);
      case 'balance':
        return this._handleBalance(ws, state);
      case 'history':
        return this._handleHistory(ws, state);
      case 'stats':
        return this._handleStats(ws);
      case 'ping':
        return this._send(ws, 'pong', { timestamp: Date.now() });
      default:
        return this._send(ws, 'error', { message: `Unknown message type: ${msg.type}` });
    }
  }

  // ---- Auth ----
  _handleAuth(ws, state, msg) {
    if (!msg.token) {
      return this._send(ws, 'error', { message: 'Token required' });
    }

    const session = this.sessions.get(msg.token);
    if (!session || Date.now() > session.expiresAt) {
      return this._send(ws, 'error', { message: 'Invalid or expired token' });
    }

    state.authenticated = true;
    state.wallet = session.wallet;

    this._send(ws, 'authenticated', {
      address: session.wallet.address,
      balance: this.dag.getBalance(session.wallet.address),
    });
  }

  // ---- Subscriptions ----
  _handleSubscribe(ws, state, msg) {
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    const added = [];

    for (const ch of channels) {
      if (ALL_CHANNELS.includes(ch)) {
        state.channels.add(ch);
        added.push(ch);
      }
    }

    this._send(ws, 'subscribed', {
      channels: [...state.channels],
      added,
    });
  }

  _handleUnsubscribe(ws, state, msg) {
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    const removed = [];

    for (const ch of channels) {
      if (state.channels.delete(ch)) {
        removed.push(ch);
      }
    }

    this._send(ws, 'unsubscribed', {
      channels: [...state.channels],
      removed,
    });
  }

  // ---- Commands (require auth) ----
  _handleTransfer(ws, state, msg) {
    if (!state.authenticated) {
      return this._send(ws, 'error', { message: 'Authentication required. Send { type: "auth", token: "..." } first.' });
    }

    if (!msg.to || !msg.amount) {
      return this._send(ws, 'error', { message: 'Fields required: to, amount' });
    }

    const { wallet } = state;
    const tips = this.dag.selectTips();
    const tx = wallet.send(msg.to, msg.amount, tips, msg.metadata || null);

    // Verify transaction
    if (this.verifyTx) {
      const v = this.verifyTx(tx);
      if (!v.valid) {
        return this._send(ws, 'error', { message: v.error });
      }
    }

    if (this.validator) {
      const validation = this.validator.validate(tx);
      if (!validation.valid) {
        return this._send(ws, 'error', { message: validation.error });
      }
    }

    const result = this.dag.addTransaction(tx);
    if (!result.success) {
      return this._send(ws, 'error', { message: result.error });
    }

    // Broadcast to P2P network
    if (this.node?.broadcastTransaction) {
      this.node.broadcastTransaction(tx).catch(() => {});
    }

    // Notify the sender
    this._send(ws, 'transfer:complete', {
      txId: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      status: 'confirmed',
    });

    // Broadcast to all subscribed clients
    this._broadcast('transactions', 'transaction', {
      id: tx.id,
      type: tx.type,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      timestamp: tx.timestamp,
      metadata: tx.metadata || null,
    });
  }

  _handleBalance(ws, state) {
    if (!state.authenticated) {
      return this._send(ws, 'error', { message: 'Authentication required' });
    }

    this._send(ws, 'balance', {
      address: state.wallet.address,
      balance: this.dag.getBalance(state.wallet.address),
      unit: 'IOTAI',
    });
  }

  _handleHistory(ws, state) {
    if (!state.authenticated) {
      return this._send(ws, 'error', { message: 'Authentication required' });
    }

    const history = this.dag.getHistory(state.wallet.address);
    this._send(ws, 'history', {
      address: state.wallet.address,
      transactions: history.map((tx) => ({
        id: tx.id,
        type: tx.type,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        timestamp: tx.timestamp,
      })),
    });
  }

  _handleStats(ws) {
    this._send(ws, 'stats', this.dag.getStats());
  }

  // ============================================================
  // EVENT BROADCASTING
  // ============================================================

  _wireEvents() {
    // Wire P2P node events if available
    if (this.node?.on) {
      this.node.on('transaction:received', (tx) => {
        this._broadcast('transactions', 'transaction', {
          id: tx.id,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          timestamp: tx.timestamp,
          metadata: tx.metadata || null,
        });
      });

      this.node.on('sync:complete', (info) => {
        this._broadcast('sync', 'sync', {
          peerId: info.peerId?.substring(0, 12) + '...',
          imported: info.imported,
          totalTransactions: this.dag.transactions.size,
        });
      });

      this.node.on('peer:connected', ({ peerId }) => {
        this._broadcast('peers', 'peer:connect', {
          peerId: peerId.substring(0, 12) + '...',
          totalPeers: this.node.getPeerCount(),
        });
      });

      this.node.on('peer:disconnected', ({ peerId }) => {
        this._broadcast('peers', 'peer:disconnect', {
          peerId: peerId.substring(0, 12) + '...',
          totalPeers: this.node.getPeerCount(),
        });
      });
    }
  }

  /**
   * Broadcast event to all clients subscribed to a channel
   */
  _broadcast(channel, event, data) {
    for (const [ws, state] of this.clients) {
      if (state.channels.has(channel) && ws.readyState === ws.OPEN) {
        this._send(ws, event, data);
      }
    }
  }

  /**
   * Send a message to a specific client
   */
  _send(ws, event, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  // ============================================================
  // STATS & CLEANUP
  // ============================================================

  getStats() {
    return {
      connectedClients: this.clients.size,
      authenticatedClients: [...this.clients.values()].filter((c) => c.authenticated).length,
    };
  }

  close() {
    clearInterval(this._heartbeatTimer);
    this.wss.close();
  }
}
