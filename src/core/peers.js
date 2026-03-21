/**
 * IOTAI Seed Node Registry
 *
 * Hardcoded list of known public nodes for bootstrapping.
 * Any node running IOTAI can be a seed. The more seeds, the more resilient the network.
 */

export const SEED_NODES = [
  'https://iotai.onrender.com',
  // Add more nodes here as they come online:
  // 'https://iotai-node2.onrender.com',
  // 'https://iotai.railway.app',
  // 'https://your-vps.example.com:3000',
];

export const PEER_CONFIG = {
  maxPeers: 50,
  healthCheckInterval: 60_000,     // 1 min
  syncInterval: 30_000,            // 30s
  peerExchangeInterval: 300_000,   // 5 min - ask peers for their peers
  connectionTimeout: 10_000,       // 10s timeout for HTTP requests
  maxReconnectAttempts: 5,
};
