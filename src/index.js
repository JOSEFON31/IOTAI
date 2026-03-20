/**
 * IOTAI - AI-Powered Distributed Cryptocurrency
 *
 * Main entry point. Starts:
 * 1. The DAG (Tangle) ledger
 * 2. A P2P node for device-to-device communication
 * 3. The consensus validator
 * 4. The Agent API for AI agents to transact
 *
 * Usage:
 *   node src/index.js                    # Start a node with default settings
 *   node src/index.js --port 4001        # Custom P2P port
 *   node src/index.js --api-port 8080    # Custom API port
 *   node src/index.js --peer /ip4/...    # Connect to a specific peer
 *   node src/index.js --sync-from https://iotai.onrender.com  # Sync from remote
 */

import { DAG } from './core/dag.js';
import { Faucet } from './core/faucet.js';
import { Storage } from './core/storage.js';
import { IOTAINode } from './network/node.js';
import { Validator } from './consensus/validator.js';
import { AgentAPI } from './api/agent-api.js';

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const p2pPort = parseInt(getArg('--port', '0'), 10);
const apiPort = parseInt(getArg('--api-port', '8080'), 10);
const peerAddr = getArg('--peer', null);
const syncFrom = getArg('--sync-from', null); // HTTP URL to sync from (e.g. https://iotai.onrender.com)

/**
 * Sync DAG state from a remote HTTP node (e.g. Render server)
 * Downloads all transactions and replays them into the local DAG
 */
async function syncFromRemote(dag, remoteUrl) {
  const url = remoteUrl.replace(/\/$/, '');

  // 1. Get remote state digest
  const stateRes = await fetch(`${url}/api/v1/p2p/state`);
  if (!stateRes.ok) throw new Error(`Remote state request failed: ${stateRes.status}`);
  const remoteState = await stateRes.json();
  console.log(`[Sync] Remote has ${remoteState.txCount} txs`);

  if (remoteState.txCount <= 1) {
    console.log('[Sync] Remote has no transactions to sync');
    return;
  }

  // 2. Request missing transactions
  const ourTxIds = [...dag.transactions.keys()];
  const syncRes = await fetch(`${url}/api/v1/p2p/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      knownTxIds: ourTxIds,
      requestMissing: true,
    }),
  });

  if (!syncRes.ok) throw new Error(`Remote sync request failed: ${syncRes.status}`);
  const syncData = await syncRes.json();

  if (!syncData.transactions || syncData.transactions.length === 0) {
    console.log('[Sync] Already up to date');
    return;
  }

  // 3. Sort by timestamp and add to DAG (multi-pass for parent dependencies)
  const txs = syncData.transactions.sort((a, b) => a.timestamp - b.timestamp);
  let added = 0;
  let pending = txs;
  let maxPasses = 5;

  while (pending.length > 0 && maxPasses-- > 0) {
    const stillPending = [];
    for (const tx of pending) {
      if (!tx || !tx.id || dag.transactions.has(tx.id)) continue;
      const parentsReady = (tx.parents || []).every(pid => dag.transactions.has(pid));
      if (!parentsReady) { stillPending.push(tx); continue; }
      const result = dag.addTransaction(tx);
      if (result.success) added++;
    }
    if (stillPending.length === pending.length) break;
    pending = stillPending;
  }

  console.log(`[Sync] Imported ${added} transactions from remote`);
}

async function main() {
  console.log('');
  console.log('  ██╗ ██████╗ ████████╗ █████╗ ██╗');
  console.log('  ██║██╔═══██╗╚══██╔══╝██╔══██╗██║');
  console.log('  ██║██║   ██║   ██║   ███████║██║');
  console.log('  ██║██║   ██║   ██║   ██╔══██║██║');
  console.log('  ██║╚██████╔╝   ██║   ██║  ██║██║');
  console.log('  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝');
  console.log('');
  console.log('  AI-Powered Distributed Cryptocurrency');
  console.log('  Every device is the network.');
  console.log('');

  // ---- Step 1: Initialize the DAG ----
  console.log('[1/4] Initializing DAG (Tangle)...');
  const dag = new DAG();
  const faucet = new Faucet(dag);
  const storage = new Storage({ dag, faucet, autoSaveInterval: 30000 });

  const loaded = await storage.load();
  if (!loaded) {
    dag.initialize(1_000_000_000);
    console.log(`  Fresh DAG: 1,000,000,000 IOTAI`);
  } else {
    console.log(`  Restored: ${dag.transactions.size} txs`);
  }

  // Sync from remote node if specified (downloads full state via HTTP)
  if (syncFrom) {
    console.log(`[Sync] Downloading state from ${syncFrom}...`);
    try {
      await syncFromRemote(dag, syncFrom);
      storage.save({ forceGithub: true });
    } catch (err) {
      console.error(`[Sync] Failed to sync from remote: ${err.message}`);
    }
  }

  storage.start();

  // ---- Step 2: Start P2P Node ----
  console.log('[2/4] Starting P2P node...');
  const node = new IOTAINode({
    dag,
    faucet,
    port: p2pPort,
    bootstrapPeers: peerAddr ? [peerAddr] : [],
  });

  const nodeInfo = await node.start();
  console.log(`  Peer ID: ${nodeInfo.peerId.substring(0, 16)}...`);

  // ---- Step 3: Start Consensus Validator ----
  console.log('[3/4] Starting consensus validator...');
  const validator = new Validator(dag, node);
  console.log(`  Confirmation threshold: ${validator.confirmationThreshold} weight`);
  console.log(`  Minimum peers required: 2`);

  // ---- Step 4: Start Agent API ----
  console.log('[4/4] Starting Agent API...');
  const api = new AgentAPI({ dag, node, validator, apiPort });
  await api.start();

  // Connect to bootstrap peer if provided
  if (peerAddr) {
    console.log(`\nConnecting to peer: ${peerAddr}`);
    await node.connectToPeer(peerAddr);
  }

  console.log('\n✓ IOTAI node is running!');
  console.log(`  P2P: ${nodeInfo.addresses[0] || 'discovering...'}`);
  console.log(`  API: http://localhost:${apiPort}`);
  console.log(`  Peers: ${node.getPeerCount()}`);
  console.log('\nAPI Endpoints for AI Agents:');
  console.log(`  POST /api/v1/wallet/create  - Create a new wallet`);
  console.log(`  POST /api/v1/auth/token     - Get auth token`);
  console.log(`  POST /api/v1/transfer       - Send IOTAI`);
  console.log(`  POST /api/v1/data           - Store data on DAG`);
  console.log(`  GET  /api/v1/balance        - Check balance`);
  console.log(`  GET  /api/v1/history        - Transaction history`);
  console.log(`  GET  /api/v1/network/stats  - Network stats`);
  console.log('');

  // Periodic sync with remote node (every 60s)
  if (syncFrom) {
    setInterval(async () => {
      try {
        await syncFromRemote(dag, syncFrom);
        storage.save();
      } catch (err) {
        console.error(`[Sync] Periodic sync error: ${err.message}`);
      }
    }, 60000);
    console.log(`  Remote sync: ${syncFrom} (every 60s)`);
  }

  // Listen for new transactions and syncs
  node.on('transaction:received', (tx) => {
    console.log(`[TX] Received: ${tx.id?.substring(0, 12)}... | ${tx.from?.substring(0, 16)} -> ${tx.to?.substring(0, 16)} | ${tx.amount} IOTAI`);
    storage.save(); // persist new tx
  });

  node.on('sync:complete', ({ peerId, imported }) => {
    console.log(`[Sync] Got ${imported} txs from peer. Saving...`);
    storage.save({ forceGithub: true }); // persist synced data
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down IOTAI...');
    await api.stop();
    await node.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
