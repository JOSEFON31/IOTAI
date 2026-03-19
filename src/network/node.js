/**
 * IOTAI P2P Node
 *
 * Each device (smartphone, computer, server) runs a node.
 * Every node stores a FULL COPY of the DAG.
 * When nodes connect, they sync their DAGs automatically.
 *
 * Discovery:
 * - mDNS (local network - zero config)
 * - Bootstrap nodes (internet-wide)
 * - KadDHT (distributed peer discovery)
 *
 * Persistence: The network IS the storage. As long as 1 node
 * is online, the entire DAG is preserved and shared with new nodes.
 *
 * Minimum 2 nodes needed for transaction verification.
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { toString, fromString } from 'uint8arrays';

const PROTOCOL_SYNC = '/iotai/sync/1.0.0';
const PROTOCOL_TX = '/iotai/tx/1.0.0';
const PROTOCOL_QUERY = '/iotai/query/1.0.0';

export class IOTAINode {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   * @param {import('../core/faucet.js').Faucet} [params.faucet]
   * @param {number} [params.port]
   * @param {string[]} [params.bootstrapPeers]
   */
  constructor({ dag, faucet = null, port = 0, bootstrapPeers = [] }) {
    this.dag = dag;
    this.faucet = faucet;
    this.port = port;
    this.bootstrapPeers = bootstrapPeers;
    this.node = null;
    this.peers = new Map();
    this.eventHandlers = new Map();
    this.syncing = false;
  }

  async start() {
    const services = {
      identify: identify(),
      dht: kadDHT({ clientMode: false }),
    };

    const peerDiscovery = [
      mdns({ interval: 10000, serviceTag: 'iotai-network' }),
    ];

    // Add bootstrap peers if configured
    if (this.bootstrapPeers.length > 0) {
      const { bootstrap } = await import('@libp2p/bootstrap');
      peerDiscovery.push(bootstrap({ list: this.bootstrapPeers }));
    }

    this.node = await createLibp2p({
      addresses: { listen: [`/ip4/0.0.0.0/tcp/${this.port}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services,
    });

    await this._setupProtocols();

    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      this.peers.set(peerId, {
        address: evt.detail.multiaddrs?.[0]?.toString() || 'unknown',
        lastSeen: Date.now(),
      });
      this._emit('peer:discovered', { peerId });
      console.log(`[P2P] Discovered: ${peerId.substring(0, 12)}...`);
    });

    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      console.log(`[P2P] Connected: ${peerId.substring(0, 12)}...`);
      this._emit('peer:connected', { peerId });
      // Auto-sync DAG with new peer
      this._syncWithPeer(peerId).catch(() => {});
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      this.peers.delete(peerId);
      this._emit('peer:disconnected', { peerId });
    });

    await this.node.start();

    const addresses = this.node.getMultiaddrs().map(ma => ma.toString());
    console.log(`[P2P] Node ID: ${this.node.peerId.toString().substring(0, 16)}...`);
    console.log(`[P2P] Listening:`, addresses);

    return { peerId: this.node.peerId.toString(), addresses };
  }

  async stop() {
    if (this.node) {
      await this.node.stop();
      console.log('[P2P] Node stopped.');
    }
  }

  /**
   * Broadcast a new transaction to all connected peers
   */
  async broadcastTransaction(tx) {
    const connections = this.node.getConnections();
    const txData = JSON.stringify(tx);
    let sent = 0;

    for (const conn of connections) {
      try {
        const stream = await conn.newStream(PROTOCOL_TX);
        await this._writeToStream(stream, txData);
        await stream.close();
        sent++;
      } catch {}
    }

    if (sent > 0) {
      console.log(`[P2P] Broadcast tx ${tx.id.substring(0, 12)}... to ${sent} peers`);
    }
    return sent;
  }

  async connectToPeer(multiaddr) {
    try {
      const { multiaddr: ma } = await import('@multiformats/multiaddr');
      await this.node.dial(ma(multiaddr));
      console.log(`[P2P] Dialed ${multiaddr}`);
    } catch (err) {
      console.error(`[P2P] Dial failed: ${err.message}`);
    }
  }

  getPeerCount() {
    return this.node ? this.node.getConnections().length : 0;
  }

  hasMinimumPeers() {
    return this.getPeerCount() >= 1;
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(handler);
  }

  // ==================== PROTOCOLS ====================

  async _setupProtocols() {
    // Incoming transaction
    await this.node.handle(PROTOCOL_TX, async ({ stream }) => {
      try {
        const data = await this._readFromStream(stream);
        const tx = JSON.parse(data);
        const result = this.dag.addTransaction(tx);
        if (result.success) {
          console.log(`[P2P] Received tx: ${tx.id.substring(0, 12)}...`);
          this._emit('transaction:received', tx);
        }
      } catch {}
    });

    // DAG sync request - send our full state
    await this.node.handle(PROTOCOL_SYNC, async ({ stream }) => {
      try {
        const request = await this._readFromStream(stream);
        const req = JSON.parse(request);

        if (req.type === 'full') {
          // Send everything
          const state = this._exportFullState();
          await this._writeToStream(stream, JSON.stringify(state));
        } else if (req.type === 'diff') {
          // Send only what they're missing
          const myTxIds = Array.from(this.dag.transactions.keys());
          const theirTxIds = new Set(req.knownTxIds || []);
          const missing = myTxIds
            .filter(id => !theirTxIds.has(id))
            .map(id => this.dag.transactions.get(id));
          await this._writeToStream(stream, JSON.stringify({
            type: 'diff',
            transactions: missing,
            balances: Object.fromEntries(this.dag.balances),
            faucet: this.faucet?.exportState() || null,
          }));
        }
      } catch {}
    });

    // Query handler
    await this.node.handle(PROTOCOL_QUERY, async ({ stream }) => {
      try {
        const queryData = await this._readFromStream(stream);
        const query = JSON.parse(queryData);
        let response;
        switch (query.type) {
          case 'balance': response = { balance: this.dag.getBalance(query.address) }; break;
          case 'transaction': response = { transaction: this.dag.getTransaction(query.id) }; break;
          case 'tips': response = { tips: this.dag.getTips() }; break;
          case 'stats': response = { stats: this.dag.getStats() }; break;
          default: response = { error: 'Unknown query' };
        }
        await this._writeToStream(stream, JSON.stringify(response));
      } catch {}
    });
  }

  // ==================== DAG SYNC ====================

  /**
   * Sync our DAG with a peer. Uses diff sync to minimize data transfer.
   */
  async _syncWithPeer(peerId) {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const connections = this.node.getConnections().filter(
        c => c.remotePeer.toString() === peerId
      );
      if (connections.length === 0) return;

      const myTxCount = this.dag.transactions.size;

      // Request diff: tell them what we have, they send what we're missing
      const stream = await connections[0].newStream(PROTOCOL_SYNC);
      const request = {
        type: myTxCount === 0 ? 'full' : 'diff',
        knownTxIds: myTxCount > 0 ? Array.from(this.dag.transactions.keys()) : [],
      };
      await this._writeToStream(stream, JSON.stringify(request));

      const data = await this._readFromStream(stream);
      const response = JSON.parse(data);

      let imported = 0;
      const transactions = (response.transactions || [])
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const tx of transactions) {
        if (!this.dag.transactions.has(tx.id)) {
          // For sync, add directly without balance checks
          this.dag.transactions.set(tx.id, tx);
          this.dag.children.set(tx.id, new Set());
          for (const parentId of tx.parents) {
            this.dag.children.get(parentId)?.add(tx.id);
            this.dag.tips.delete(parentId);
          }
          this.dag.tips.add(tx.id);
          if (tx.nonce) this.dag.usedNonces.add(tx.nonce);
          imported++;
        }
      }

      // Restore balances from peer if we had nothing
      if (myTxCount === 0 && response.balances) {
        this.dag.balances = new Map(
          Object.entries(response.balances).map(([k, v]) => [k, Number(v)])
        );
      }

      // Sync faucet state if we had nothing
      if (myTxCount === 0 && response.faucet && this.faucet) {
        this.faucet.importState(response.faucet);
      }

      if (imported > 0) {
        console.log(`[P2P] Synced ${imported} txs from ${peerId.substring(0, 12)}... (total: ${this.dag.transactions.size})`);
        this._emit('sync:complete', { peerId, imported });
      }
    } catch (err) {
      console.log(`[P2P] Sync failed with ${peerId.substring(0, 12)}...: ${err.message}`);
    } finally {
      this.syncing = false;
    }
  }

  _exportFullState() {
    return {
      type: 'full',
      transactions: Array.from(this.dag.transactions.values()),
      balances: Object.fromEntries(this.dag.balances),
      faucet: this.faucet?.exportState() || null,
    };
  }

  // ==================== STREAM HELPERS ====================

  async _writeToStream(stream, data) {
    const encoded = fromString(data);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, encoded.length, false);
    await stream.sink([length, encoded]);
  }

  async _readFromStream(stream) {
    const chunks = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk.subarray());
    }
    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const start = combined.length > 4 ? 4 : 0;
    return toString(combined.subarray(start));
  }

  _emit(event, data) {
    for (const handler of (this.eventHandlers.get(event) || [])) {
      handler(data);
    }
  }
}
