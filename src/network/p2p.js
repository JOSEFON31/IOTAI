/**
 * IOTAI P2P Sync Module
 *
 * Multi-node synchronization for the IOTAI DAG network.
 * Supports peer discovery, state synchronization, and transaction broadcasting.
 *
 * Design:
 *  - HTTP-based peer communication (works on cloud platforms)
 *  - Pull-based sync with periodic polling
 *  - Transaction broadcasting to all connected peers
 *  - State digest comparison for efficient sync
 */

import { hash } from '../core/crypto.js';
import { SEED_NODES, PEER_CONFIG } from '../core/peers.js';

export class P2PSync {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   * @param {string} params.nodeId - Unique identifier for this node
   * @param {string} [params.nodeUrl] - Public URL of this node (for peers to connect back)
   * @param {number} [params.syncInterval] - Sync interval in ms (default 30s)
   * @param {string[]} [params.seedNodes] - Bootstrap seed nodes
   * @param {function} [params.onSyncComplete] - Callback after sync imports new txs
   */
  constructor({ dag, nodeId, nodeUrl, syncInterval = 30000, seedNodes, onSyncComplete }) {
    this.dag = dag;
    this.nodeId = nodeId || this._generateNodeId();
    this.nodeUrl = nodeUrl || null;
    this.syncInterval = syncInterval;
    this.seedNodes = seedNodes || SEED_NODES;
    this.onSyncComplete = onSyncComplete || null;

    /** @type {Map<string, Peer>} url -> peer info */
    this.peers = new Map();

    /** @type {Set<string>} Recently synced tx IDs (avoid re-broadcasting) */
    this.recentlySynced = new Set();

    this.startedAt = Date.now();
    this._syncTimer = null;
    this._healthTimer = null;
    this._peerExchangeTimer = null;
    this._maxRecentSynced = 10000;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /** Start periodic sync, auto-connect to seeds, health checks */
  start() {
    if (this._syncTimer) return;

    // Auto-connect to seed nodes
    this._connectToSeeds();

    // Periodic sync
    this._syncTimer = setInterval(() => {
      this.syncWithPeers().catch(err =>
        console.error('[P2P] Sync error:', err.message)
      );
      this._pruneRecentSynced();
    }, this.syncInterval);

    // Health check: remove dead peers, reconnect to seeds
    this._healthTimer = setInterval(() => {
      this._healthCheck();
    }, PEER_CONFIG.healthCheckInterval);

    // Peer exchange: ask peers for their peer lists
    this._peerExchangeTimer = setInterval(() => {
      this._peerExchange().catch(() => {});
    }, PEER_CONFIG.peerExchangeInterval);

    console.log(`[P2P] Node ${this.nodeId.substring(0, 8)} started (sync every ${this.syncInterval / 1000}s, ${this.seedNodes.length} seed(s))`);
  }

  /** Stop all timers */
  stop() {
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._peerExchangeTimer) { clearInterval(this._peerExchangeTimer); this._peerExchangeTimer = null; }
  }

  /** Add a peer node */
  async addPeer(url) {
    // Normalize URL
    url = url.replace(/\/$/, '');

    if (this.peers.has(url)) {
      return { success: false, error: 'Peer already exists' };
    }

    // Try handshake
    try {
      const response = await this._request(url, '/api/v1/p2p/handshake', {
        nodeId: this.nodeId,
        nodeUrl: this.nodeUrl,
        version: '1.0.0',
        txCount: this.dag.transactions.size,
      });

      if (!response || !response.nodeId) {
        return { success: false, error: 'Invalid handshake response' };
      }

      const peer = {
        url,
        nodeId: response.nodeId,
        version: response.version || '1.0.0',
        txCount: response.txCount || 0,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        lastSync: null,
        syncCount: 0,
        txReceived: 0,
        txSent: 0,
        status: 'connected',
        latency: 0,
      };

      this.peers.set(url, peer);
      console.log(`[P2P] Connected to peer ${response.nodeId.substring(0, 8)} at ${url}`);
      return { success: true, peer };

    } catch (err) {
      return { success: false, error: `Handshake failed: ${err.message}` };
    }
  }

  /** Remove a peer */
  removePeer(url) {
    url = url.replace(/\/$/, '');
    const existed = this.peers.delete(url);
    return { success: existed };
  }

  /** Sync with all connected peers */
  async syncWithPeers() {
    const results = { synced: 0, failed: 0, txReceived: 0, txSent: 0 };

    for (const [url, peer] of this.peers) {
      try {
        const result = await this._syncWithPeer(url, peer);
        results.synced++;
        results.txReceived += result.received;
        results.txSent += result.sent;
        peer.lastSync = Date.now();
        peer.syncCount++;
        peer.status = 'connected';
      } catch (err) {
        results.failed++;
        peer.status = 'error';
        peer.lastError = err.message;
        console.error(`[P2P] Sync failed with ${url}: ${err.message}`);
      }
    }

    return results;
  }

  /** Broadcast a new transaction to all peers */
  async broadcastTransaction(tx) {
    if (this.recentlySynced.has(tx.id)) return { sent: 0 };

    this.recentlySynced.add(tx.id);
    let sent = 0;

    for (const [url, peer] of this.peers) {
      if (peer.status !== 'connected') continue;
      try {
        await this._request(url, '/api/v1/p2p/transactions', {
          transactions: [tx],
          fromNode: this.nodeId,
        });
        sent++;
        peer.txSent++;
      } catch {
        // Silently fail - will retry on next sync
      }
    }

    return { sent };
  }

  // ============================================================
  // PEER-TO-PEER HANDLERS (called by other nodes)
  // ============================================================

  /** Handle incoming handshake from a peer */
  handleHandshake(body) {
    const { nodeId, nodeUrl, version, txCount } = body || {};

    // Auto-add peer if they provided their URL
    if (nodeUrl && !this.peers.has(nodeUrl)) {
      this.peers.set(nodeUrl, {
        url: nodeUrl,
        nodeId: nodeId || 'unknown',
        version: version || '1.0.0',
        txCount: txCount || 0,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        lastSync: null,
        syncCount: 0,
        txReceived: 0,
        txSent: 0,
        status: 'connected',
        latency: 0,
      });
      console.log(`[P2P] Peer ${(nodeId || 'unknown').substring(0, 8)} registered (${nodeUrl})`);
    }

    return {
      nodeId: this.nodeId,
      version: '1.0.0',
      txCount: this.dag.transactions.size,
      uptime: Date.now() - this.startedAt,
    };
  }

  /** Handle incoming transactions from a peer */
  handleIncomingTransactions(transactions) {
    let accepted = 0;
    let rejected = 0;
    let duplicate = 0;

    // Sort by timestamp to ensure parents arrive before children
    const sorted = [...transactions].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Multi-pass: some txs may depend on parents that arrive in the same batch
    let pending = sorted;
    let maxPasses = 5;

    while (pending.length > 0 && maxPasses-- > 0) {
      const stillPending = [];

      for (const tx of pending) {
        if (!tx || !tx.id) { rejected++; continue; }

        // Skip if already have it
        if (this.dag.transactions.has(tx.id)) {
          duplicate++;
          this.recentlySynced.add(tx.id);
          continue;
        }

        // Check if all parents exist
        const parentsReady = (tx.parents || []).every(pid => this.dag.transactions.has(pid));
        if (!parentsReady) {
          stillPending.push(tx);
          continue;
        }

        // Validate and add
        const result = this.dag.addTransaction(tx);
        if (result.success) {
          accepted++;
          this.recentlySynced.add(tx.id);
        } else {
          rejected++;
        }
      }

      // If no progress was made, stop trying
      if (stillPending.length === pending.length) {
        rejected += stillPending.length;
        break;
      }
      pending = stillPending;
    }

    if (accepted > 0) {
      console.log(`[P2P] Imported ${accepted} txs (${duplicate} dup, ${rejected} rejected)`);
      // Notify listeners (exchange/social re-indexing)
      if (this.onSyncComplete) {
        try { this.onSyncComplete(accepted); } catch {}
      }
    }

    return { accepted, rejected, duplicate, total: transactions.length };
  }

  /** Get state digest for comparison */
  getStateDigest() {
    const txIds = [...this.dag.transactions.keys()].sort();
    const tipIds = [...this.dag.tips].sort();

    return {
      nodeId: this.nodeId,
      txCount: txIds.length,
      tipCount: tipIds.length,
      stateHash: hash(txIds.join(',')).substring(0, 16),
      tipHash: hash(tipIds.join(',')).substring(0, 16),
      genesisId: this.dag.genesisId,
      timestamp: Date.now(),
    };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /** Get list of connected peers */
  getPeers() {
    const peers = [];
    for (const [url, peer] of this.peers) {
      peers.push({
        url,
        nodeId: peer.nodeId,
        status: peer.status,
        connectedAt: peer.connectedAt,
        lastSeen: peer.lastSeen,
        lastSync: peer.lastSync,
        syncCount: peer.syncCount,
        txReceived: peer.txReceived,
        txSent: peer.txSent,
        latency: peer.latency,
        version: peer.version,
      });
    }
    return peers;
  }

  /** Get this node's info */
  getNodeInfo() {
    return {
      nodeId: this.nodeId,
      nodeUrl: this.nodeUrl,
      version: '1.0.0',
      uptime: Date.now() - this.startedAt,
      txCount: this.dag.transactions.size,
      tipCount: this.dag.tips.size,
      peerCount: this.peers.size,
      connectedPeers: [...this.peers.values()].filter(p => p.status === 'connected').length,
      syncInterval: this.syncInterval,
      startedAt: this.startedAt,
    };
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  /** Sync with a single peer - exchange missing transactions */
  async _syncWithPeer(url, peer) {
    const start = Date.now();
    let received = 0;
    let sent = 0;

    // 1. Get peer's state digest
    const peerState = await this._request(url, '/api/v1/p2p/state', null, 'GET');
    peer.latency = Date.now() - start;
    peer.lastSeen = Date.now();

    if (!peerState || !peerState.stateHash) {
      throw new Error('Invalid state response');
    }

    // 2. Compare state - if hashes match, no sync needed
    const ourState = this.getStateDigest();
    if (ourState.stateHash === peerState.stateHash) {
      return { received: 0, sent: 0 };
    }

    // 3. Pull: Request transactions we're missing from the peer
    const ourTxIds = [...this.dag.transactions.keys()];
    const pullResponse = await this._request(url, '/api/v1/p2p/transactions', {
      knownTxIds: ourTxIds,
      fromNode: this.nodeId,
      requestMissing: true,
    });

    // Process received transactions (they come sorted by timestamp)
    if (pullResponse?.transactions && Array.isArray(pullResponse.transactions)) {
      for (const tx of pullResponse.transactions) {
        if (!tx || !tx.id || this.dag.transactions.has(tx.id)) continue;
        const result = this.dag.addTransaction(tx);
        if (result.success) {
          received++;
          this.recentlySynced.add(tx.id);
        }
      }
      peer.txReceived += received;
      if (received > 0) {
        console.log(`[P2P] Received ${received} txs from ${peer.nodeId?.substring(0, 8) || url}`);
        if (this.onSyncComplete) {
          try { this.onSyncComplete(received); } catch {}
        }
      }
    }

    // 4. Push: Send our transactions that the peer is missing
    // Get peer's known tx IDs by asking them what they have
    const peerTxIds = new Set();
    // We know from pullResponse which txs they sent us (they had those)
    // For a full push, send all our txs that aren't in the recently synced set
    const pushTxs = [...this.dag.transactions.values()]
      .filter(tx => !this.recentlySynced.has(tx.id))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (pushTxs.length > 0) {
      // Send in batches of 200 to avoid huge payloads
      for (let i = 0; i < pushTxs.length; i += 200) {
        const batch = pushTxs.slice(i, i + 200);
        const pushResult = await this._request(url, '/api/v1/p2p/transactions', {
          transactions: batch,
          fromNode: this.nodeId,
        });
        sent += pushResult?.accepted || 0;
      }
      peer.txSent += sent;
    }

    // Mark all our txs as synced with this peer
    for (const tx of pushTxs) {
      this.recentlySynced.add(tx.id);
    }

    peer.txCount = peerState.txCount;
    return { received, sent };
  }

  /** Make HTTP request to a peer */
  async _request(url, path, body, method = 'POST') {
    const fullUrl = url + path;

    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      if (body && method === 'POST') {
        options.body = JSON.stringify(body);
      }

      const controller = new AbortController();
      // Longer timeout for sync requests (may transfer many txs)
      const timeoutMs = (body?.requestMissing || body?.transactions?.length > 10) ? 30000 : 10000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      options.signal = controller.signal;

      const res = await fetch(fullUrl, options);
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw err;
    }
  }

  /** Generate unique node ID */
  _generateNodeId() {
    return 'node_' + hash(Date.now().toString() + Math.random().toString()).substring(0, 16);
  }

  /** Prune recently synced set to avoid memory leak */
  _pruneRecentSynced() {
    if (this.recentlySynced.size > this._maxRecentSynced) {
      const arr = [...this.recentlySynced];
      this.recentlySynced = new Set(arr.slice(arr.length - 5000));
    }
  }

  /** Auto-connect to all seed nodes on startup */
  async _connectToSeeds() {
    const myUrl = this.nodeUrl || '';
    for (const seed of this.seedNodes) {
      if (seed === myUrl || this.peers.has(seed)) continue;
      this.addPeer(seed).catch(() => {});
    }
  }

  /** Health check: remove dead peers, reconnect to seeds */
  _healthCheck() {
    const now = Date.now();
    const deadTimeout = PEER_CONFIG.healthCheckInterval * 3; // 3 missed checks = dead

    for (const [url, peer] of this.peers) {
      if (peer.status === 'error' && peer.lastSeen && (now - peer.lastSeen > deadTimeout)) {
        console.log(`[P2P] Removing dead peer ${url}`);
        this.peers.delete(url);
      }
    }

    // Reconnect to seeds if we lost them
    this._connectToSeeds();
  }

  /** Peer exchange: ask peers for their peer lists, connect to new ones */
  async _peerExchange() {
    if (this.peers.size >= PEER_CONFIG.maxPeers) return;

    for (const [url, peer] of this.peers) {
      if (peer.status !== 'connected') continue;
      try {
        const peerList = await this._request(url, '/api/v1/p2p/peers', null, 'GET');
        if (!Array.isArray(peerList)) continue;

        for (const p of peerList) {
          const pUrl = p.url || p;
          if (!pUrl || pUrl === this.nodeUrl || this.peers.has(pUrl)) continue;
          if (this.peers.size >= PEER_CONFIG.maxPeers) return;
          this.addPeer(pUrl).catch(() => {});
        }
      } catch {}
    }
  }
}
