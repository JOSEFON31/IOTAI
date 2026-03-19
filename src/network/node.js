/**
 * IOTAI P2P Node
 *
 * Each device (smartphone, computer, server) runs a node.
 * Nodes discover each other via:
 * - mDNS (local network discovery - zero config)
 * - Bootstrap nodes (for internet-wide connectivity)
 * - KadDHT (distributed hash table for peer discovery)
 *
 * The network has NO central server. Infrastructure is the devices themselves.
 * Minimum 2 nodes are needed for transaction verification.
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { toString, fromString } from 'uint8arrays';

// Protocol identifier for IOTAI
const PROTOCOL_SYNC = '/iotai/sync/1.0.0';
const PROTOCOL_TX = '/iotai/tx/1.0.0';
const PROTOCOL_QUERY = '/iotai/query/1.0.0';

export class IOTAINode {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag - the local DAG instance
   * @param {number} [params.port] - TCP port (0 = random available port)
   * @param {string[]} [params.bootstrapPeers] - known peer multiaddrs
   */
  constructor({ dag, port = 0, bootstrapPeers = [] }) {
    this.dag = dag;
    this.port = port;
    this.bootstrapPeers = bootstrapPeers;
    this.node = null;
    this.peers = new Map(); // peerId -> { address, lastSeen }
    this.eventHandlers = new Map();
  }

  /**
   * Start the P2P node
   */
  async start() {
    this.node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${this.port}`],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        // Auto-discover peers on local network (LAN)
        mdns({
          interval: 10000, // search every 10 seconds
          serviceTag: 'iotai-network',
        }),
      ],
      services: {
        // Distributed Hash Table for global peer discovery
        dht: kadDHT({
          clientMode: false,
        }),
      },
    });

    // Set up protocol handlers
    await this._setupProtocols();

    // Handle peer discovery
    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      this.peers.set(peerId, {
        address: evt.detail.multiaddrs?.[0]?.toString() || 'unknown',
        lastSeen: Date.now(),
      });
      this._emit('peer:discovered', { peerId });
      console.log(`[IOTAI] Discovered peer: ${peerId.substring(0, 12)}...`);
    });

    // Handle peer connections
    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      console.log(`[IOTAI] Connected to peer: ${peerId.substring(0, 12)}...`);
      this._emit('peer:connected', { peerId });

      // Sync DAG with new peer
      this._syncWithPeer(peerId).catch(console.error);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      this.peers.delete(peerId);
      this._emit('peer:disconnected', { peerId });
    });

    await this.node.start();

    const addresses = this.node.getMultiaddrs().map((ma) => ma.toString());
    console.log(`[IOTAI] Node started. ID: ${this.node.peerId.toString().substring(0, 12)}...`);
    console.log(`[IOTAI] Listening on:`, addresses);

    return {
      peerId: this.node.peerId.toString(),
      addresses,
    };
  }

  /**
   * Stop the node
   */
  async stop() {
    if (this.node) {
      await this.node.stop();
      console.log('[IOTAI] Node stopped.');
    }
  }

  /**
   * Broadcast a new transaction to all connected peers
   * @param {import('../core/transaction.js').Transaction} tx
   */
  async broadcastTransaction(tx) {
    const connections = this.node.getConnections();
    const txData = JSON.stringify(tx);
    let sent = 0;

    for (const connection of connections) {
      try {
        const stream = await connection.newStream(PROTOCOL_TX);
        await this._writeToStream(stream, txData);
        await stream.close();
        sent++;
      } catch (err) {
        console.error(`[IOTAI] Failed to send tx to ${connection.remotePeer}:`, err.message);
      }
    }

    console.log(`[IOTAI] Broadcast tx ${tx.id.substring(0, 12)}... to ${sent} peers`);
    return sent;
  }

  /**
   * Connect to a specific peer by multiaddr
   * @param {string} multiaddr
   */
  async connectToPeer(multiaddr) {
    try {
      const { multiaddr: ma } = await import('@multiformats/multiaddr');
      await this.node.dial(ma(multiaddr));
      console.log(`[IOTAI] Connected to ${multiaddr}`);
    } catch (err) {
      console.error(`[IOTAI] Failed to connect to ${multiaddr}:`, err.message);
    }
  }

  /**
   * Get the number of connected peers
   * @returns {number}
   */
  getPeerCount() {
    return this.node ? this.node.getConnections().length : 0;
  }

  /**
   * Check if minimum verification requirement is met (2 nodes)
   * @returns {boolean}
   */
  hasMinimumPeers() {
    return this.getPeerCount() >= 1; // us + 1 peer = 2 nodes
  }

  /**
   * Register an event handler
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  async _setupProtocols() {
    // Handle incoming transaction broadcasts
    await this.node.handle(PROTOCOL_TX, async ({ stream }) => {
      try {
        const data = await this._readFromStream(stream);
        const tx = JSON.parse(data);

        const result = this.dag.addTransaction(tx);
        if (result.success) {
          console.log(`[IOTAI] Received and added tx: ${tx.id.substring(0, 12)}...`);
          this._emit('transaction:received', tx);
        }
      } catch (err) {
        console.error('[IOTAI] Error processing incoming tx:', err.message);
      }
    });

    // Handle DAG sync requests
    await this.node.handle(PROTOCOL_SYNC, async ({ stream }) => {
      try {
        const state = this.dag.exportState();
        await this._writeToStream(stream, JSON.stringify(state));
      } catch (err) {
        console.error('[IOTAI] Error during sync:', err.message);
      }
    });

    // Handle balance/state queries
    await this.node.handle(PROTOCOL_QUERY, async ({ stream }) => {
      try {
        const queryData = await this._readFromStream(stream);
        const query = JSON.parse(queryData);

        let response;
        switch (query.type) {
          case 'balance':
            response = { balance: this.dag.getBalance(query.address) };
            break;
          case 'transaction':
            response = { transaction: this.dag.getTransaction(query.id) };
            break;
          case 'tips':
            response = { tips: this.dag.getTips() };
            break;
          case 'stats':
            response = { stats: this.dag.getStats() };
            break;
          default:
            response = { error: 'Unknown query type' };
        }

        await this._writeToStream(stream, JSON.stringify(response));
      } catch (err) {
        console.error('[IOTAI] Error handling query:', err.message);
      }
    });
  }

  /**
   * Sync our DAG with a newly connected peer
   */
  async _syncWithPeer(peerId) {
    try {
      const connections = this.node.getConnections().filter(
        (c) => c.remotePeer.toString() === peerId
      );

      if (connections.length === 0) return;

      const stream = await connections[0].newStream(PROTOCOL_SYNC);
      const data = await this._readFromStream(stream);
      const remoteState = JSON.parse(data);

      // Import missing transactions
      let imported = 0;
      for (const tx of remoteState.transactions) {
        if (!this.dag.transactions.has(tx.id)) {
          const result = this.dag.addTransaction(tx);
          if (result.success) imported++;
        }
      }

      if (imported > 0) {
        console.log(`[IOTAI] Synced ${imported} transactions from peer ${peerId.substring(0, 12)}...`);
      }
    } catch (err) {
      // Peer might not respond to sync - that's ok
      console.log(`[IOTAI] Could not sync with peer: ${err.message}`);
    }
  }

  async _writeToStream(stream, data) {
    const encoded = fromString(data);
    // Length-prefixed message
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, encoded.length, false);
    await stream.sink([length, encoded]);
  }

  async _readFromStream(stream) {
    const chunks = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk.subarray());
    }
    const combined = new Uint8Array(
      chunks.reduce((acc, c) => acc + c.length, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    // Skip 4-byte length prefix if present
    const start = combined.length > 4 ? 4 : 0;
    return toString(combined.subarray(start));
  }

  _emit(event, data) {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      handler(data);
    }
  }
}
