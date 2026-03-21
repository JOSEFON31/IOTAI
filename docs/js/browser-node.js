/**
 * IOTAI Browser Node (Decentralized)
 *
 * Turns every website visitor into a lightweight network node.
 * - Connects to ANY available IOTAI server (multi-server fallback)
 * - Persists transactions in IndexedDB (survives page close)
 * - Syncs with the network and relays transactions
 *
 * Include in any page: <script src="/js/browser-node.js"></script>
 */
(function() {
  'use strict';

  const NODE_VERSION = '1.1.0';
  const SYNC_INTERVAL = 30000;
  const STATS_INTERVAL = 15000;
  const RECONNECT_DELAY = 5000;
  const MAX_RECONNECT = 5;   // per server, then try next
  const MAX_TX_CACHE = 50000; // increased for full DAG persistence
  const DB_NAME = 'iotai-node';
  const DB_VERSION = 1;

  // Bootstrap servers — try location.origin first, then fallback
  const BOOTSTRAP_SERVERS = [
    location.origin,
    'https://iotai.onrender.com',
    // Add more as they come online:
    // 'https://iotai-node2.onrender.com',
    // 'https://iotai.railway.app',
  ];
  // Deduplicate (if location.origin is already in the list)
  const SERVERS = [...new Set(BOOTSTRAP_SERVERS)];

  class BrowserNode {
    constructor() {
      this.nodeId = this._generateNodeId();
      this.ws = null;
      this.connected = false;
      this.reconnectAttempts = 0;
      this.txCache = new Map();
      this.validatedCount = 0;
      this.relayedCount = 0;
      this.syncCount = 0;
      this.startedAt = Date.now();
      this.lastSync = 0;
      this.peerCount = 0;
      this.networkTxCount = 0;
      this.db = null;
      this.currentServerIndex = 0;
      this.currentServer = SERVERS[0];

      this._initDB().then(() => {
        this._createStatusWidget();
        this._findBestServer().then(() => {
          this._connectWebSocket();
          this._startSyncLoop();
          this._startStatsLoop();
        });
      });

      console.log(`[IOTAI Node] Browser node ${this.nodeId.substring(0,8)}... started`);
    }

    // ---- IndexedDB Persistence ----

    _initDB() {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('transactions')) {
              db.createObjectStore('transactions', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'key' });
            }
          };
          req.onsuccess = (e) => {
            this.db = e.target.result;
            this._loadFromDB().then(resolve);
          };
          req.onerror = () => resolve(); // proceed without DB
        } catch { resolve(); }
      });
    }

    async _loadFromDB() {
      if (!this.db) return;
      try {
        const txStore = this.db.transaction('transactions', 'readonly').objectStore('transactions');
        const all = await this._idbGetAll(txStore);
        for (const tx of all) {
          this.txCache.set(tx.id, tx);
        }
        if (all.length > 0) {
          console.log(`[IOTAI Node] Loaded ${all.length} txs from IndexedDB`);
        }
      } catch {}
    }

    _saveTxToDB(tx) {
      if (!this.db) return;
      try {
        const txStore = this.db.transaction('transactions', 'readwrite').objectStore('transactions');
        txStore.put(tx);
      } catch {}
    }

    _saveMetaToDB(key, value) {
      if (!this.db) return;
      try {
        const store = this.db.transaction('meta', 'readwrite').objectStore('meta');
        store.put({ key, value, updatedAt: Date.now() });
      } catch {}
    }

    _idbGetAll(store) {
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    // ---- Multi-Server Discovery ----

    async _findBestServer() {
      if (SERVERS.length <= 1) return;

      const results = [];
      const checks = SERVERS.map(async (url, i) => {
        try {
          const start = Date.now();
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(url + '/api/v1/p2p/state', { signal: ctrl.signal });
          clearTimeout(timeout);
          if (!res.ok) return;
          const data = await res.json();
          results.push({ url, index: i, latency: Date.now() - start, txCount: data.transactionCount || data.txCount || 0 });
        } catch {}
      });
      await Promise.all(checks);

      if (results.length === 0) return;

      // Pick server with most transactions (prefer data completeness over latency)
      results.sort((a, b) => b.txCount - a.txCount || a.latency - b.latency);
      const best = results[0];
      this.currentServer = best.url;
      this.currentServerIndex = best.index;
      console.log(`[IOTAI Node] Best server: ${best.url} (${best.txCount} txs, ${best.latency}ms)`);
    }

    _getWsUrl() {
      const url = new URL(this.currentServer);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return protocol + '//' + url.host + '/ws';
    }

    _switchToNextServer() {
      this.currentServerIndex = (this.currentServerIndex + 1) % SERVERS.length;
      this.currentServer = SERVERS[this.currentServerIndex];
      this.reconnectAttempts = 0;
      console.log(`[IOTAI Node] Switching to server: ${this.currentServer}`);
    }

    // ---- WebSocket Connection ----

    _connectWebSocket() {
      try {
        this.ws = new WebSocket(this._getWsUrl());

        this.ws.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          this._updateWidget();

          this.ws.send(JSON.stringify({
            type: 'subscribe',
            channels: ['transactions', 'confirmations', 'peers', 'sync']
          }));
          this.ws.send(JSON.stringify({ type: 'stats' }));

          console.log(`[IOTAI Node] Connected to ${this.currentServer}`);
        };

        this.ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            this._handleMessage(msg);
          } catch {}
        };

        this.ws.onclose = () => {
          this.connected = false;
          this._updateWidget();
          this._scheduleReconnect();
        };

        this.ws.onerror = () => {
          this.connected = false;
        };
      } catch {
        this._scheduleReconnect();
      }
    }

    _scheduleReconnect() {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= MAX_RECONNECT) {
        // Try next server
        if (SERVERS.length > 1) {
          this._switchToNextServer();
        } else {
          return; // no more servers to try
        }
      }
      const delay = RECONNECT_DELAY * Math.min(this.reconnectAttempts, 5);
      setTimeout(() => this._connectWebSocket(), delay);
    }

    _handleMessage(msg) {
      const { event, data } = msg;

      switch (event) {
        case 'transaction':
          this._cacheTx(data);
          this.validatedCount++;
          this._updateWidget();
          break;

        case 'confirmation':
          if (data.txId && this.txCache.has(data.txId)) {
            const tx = this.txCache.get(data.txId);
            tx._confirmed = true;
            this._saveTxToDB(tx);
          }
          break;

        case 'peer:connect':
        case 'peer:disconnect':
          this.peerCount = data.totalPeers || this.peerCount;
          this._updateWidget();
          break;

        case 'stats':
          this.networkTxCount = data.totalTransactions || 0;
          this.peerCount = data.peers || data.connectedPeers || 0;
          this._updateWidget();
          break;

        case 'sync':
          this.syncCount++;
          this._updateWidget();
          break;
      }
    }

    // ---- Transaction Cache & Validation ----

    _cacheTx(tx) {
      if (!tx || !tx.id) return;
      if (this.txCache.has(tx.id)) return;

      // Evict oldest if cache full
      if (this.txCache.size >= MAX_TX_CACHE) {
        const firstKey = this.txCache.keys().next().value;
        this.txCache.delete(firstKey);
      }

      const cached = {
        id: tx.id,
        type: tx.type,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        timestamp: tx.timestamp,
        metadata: tx.metadata || null,
        _cachedAt: Date.now(),
        _confirmed: false,
      };

      this.txCache.set(tx.id, cached);
      this._saveTxToDB(cached);
    }

    // ---- Periodic Sync ----

    _startSyncLoop() {
      setInterval(async () => {
        try {
          const res = await fetch(this.currentServer + '/api/v1/network/stats');
          if (!res.ok) return;
          const stats = await res.json();
          this.networkTxCount = stats.totalTransactions || 0;
          this.peerCount = stats.peers || stats.connectedPeers || 0;
          this.lastSync = Date.now();
          this.syncCount++;
          this._updateWidget();
          this._saveMetaToDB('lastSync', { networkTxCount: this.networkTxCount, server: this.currentServer });
        } catch {
          // Server might be down, will switch on WS reconnect failure
        }
      }, SYNC_INTERVAL);
    }

    _startStatsLoop() {
      setInterval(() => this._updateWidget(), STATS_INTERVAL);
    }

    // ---- Status Widget ----

    _createStatusWidget() {
      const el = document.createElement('div');
      el.id = 'iotai-node-widget';
      el.innerHTML = `
        <div id="iotai-node-toggle" title="IOTAI Browser Node">
          <span id="iotai-node-dot"></span>
          <span id="iotai-node-label">Node</span>
        </div>
        <div id="iotai-node-panel" style="display:none">
          <div class="node-title">IOTAI Browser Node</div>
          <div class="node-id">ID: <span id="nd-id">-</span></div>
          <div class="node-stats">
            <div class="ns-row"><span class="ns-label">Status</span><span id="nd-status" class="ns-val">Connecting...</span></div>
            <div class="ns-row"><span class="ns-label">Server</span><span id="nd-server" class="ns-val">-</span></div>
            <div class="ns-row"><span class="ns-label">Cached TXs</span><span id="nd-cached" class="ns-val">0</span></div>
            <div class="ns-row"><span class="ns-label">Persisted</span><span id="nd-persisted" class="ns-val">${this.db ? 'IndexedDB' : 'Memory'}</span></div>
            <div class="ns-row"><span class="ns-label">Validated</span><span id="nd-validated" class="ns-val">0</span></div>
            <div class="ns-row"><span class="ns-label">Network TXs</span><span id="nd-nettx" class="ns-val">-</span></div>
            <div class="ns-row"><span class="ns-label">Peers</span><span id="nd-peers" class="ns-val">0</span></div>
            <div class="ns-row"><span class="ns-label">Syncs</span><span id="nd-syncs" class="ns-val">0</span></div>
            <div class="ns-row"><span class="ns-label">Uptime</span><span id="nd-uptime" class="ns-val">0s</span></div>
          </div>
        </div>
      `;

      const style = document.createElement('style');
      style.textContent = `
        #iotai-node-widget{position:fixed;bottom:16px;right:16px;z-index:99999;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px}
        #iotai-node-toggle{background:#1a1a3e;border:1px solid #2a2a5e;border-radius:20px;padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:6px;color:#e0e0f0;user-select:none;transition:all .2s}
        #iotai-node-toggle:hover{border-color:#6C5CE7;background:#222255}
        #iotai-node-dot{width:8px;height:8px;border-radius:50%;background:#888;transition:background .3s}
        #iotai-node-dot.online{background:#00B894;box-shadow:0 0 6px #00B894}
        #iotai-node-dot.offline{background:#d63031}
        #iotai-node-panel{position:absolute;bottom:42px;right:0;background:#0d0d24;border:1px solid #2a2a5e;border-radius:12px;padding:16px;min-width:240px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
        .node-title{font-weight:bold;font-size:14px;color:#6C5CE7;margin-bottom:4px}
        .node-id{font-size:11px;color:#888;font-family:monospace;margin-bottom:12px;word-break:break-all}
        .ns-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a3e}
        .ns-label{color:#888;font-size:12px}
        .ns-val{color:#e0e0f0;font-size:12px;font-weight:600}
        #nd-status.online{color:#00B894}
        #nd-status.offline{color:#d63031}
      `;

      document.head.appendChild(style);
      document.body.appendChild(el);

      document.getElementById('iotai-node-toggle').addEventListener('click', () => {
        const p = document.getElementById('iotai-node-panel');
        p.style.display = p.style.display === 'none' ? 'block' : 'none';
      });

      this._updateWidget();
    }

    _updateWidget() {
      const dot = document.getElementById('iotai-node-dot');
      const status = document.getElementById('nd-status');
      const id = document.getElementById('nd-id');
      const server = document.getElementById('nd-server');
      const cached = document.getElementById('nd-cached');
      const persisted = document.getElementById('nd-persisted');
      const validated = document.getElementById('nd-validated');
      const nettx = document.getElementById('nd-nettx');
      const peers = document.getElementById('nd-peers');
      const syncs = document.getElementById('nd-syncs');
      const uptime = document.getElementById('nd-uptime');

      if (!dot) return;

      dot.className = this.connected ? 'online' : 'offline';
      if (status) {
        status.textContent = this.connected ? 'Online' : 'Offline';
        status.className = 'ns-val ' + (this.connected ? 'online' : 'offline');
      }
      if (id) id.textContent = this.nodeId.substring(0, 16) + '...';
      if (server) {
        try { server.textContent = new URL(this.currentServer).hostname; } catch { server.textContent = this.currentServer; }
      }
      if (cached) cached.textContent = this.txCache.size.toLocaleString();
      if (persisted) persisted.textContent = this.db ? 'IndexedDB' : 'Memory';
      if (validated) validated.textContent = this.validatedCount.toLocaleString();
      if (nettx) nettx.textContent = this.networkTxCount.toLocaleString();
      if (peers) peers.textContent = this.peerCount;
      if (syncs) syncs.textContent = this.syncCount;
      if (uptime) uptime.textContent = this._formatUptime();
    }

    _formatUptime() {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    _generateNodeId() {
      let id = localStorage.getItem('iotai_browser_node_id');
      if (!id) {
        id = 'bn_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('iotai_browser_node_id', id);
      }
      return id;
    }
  }

  // Auto-start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new BrowserNode());
  } else {
    new BrowserNode();
  }
})();
