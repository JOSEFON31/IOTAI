# IOTAI

AI-Powered Distributed Cryptocurrency built on a DAG (Tangle) architecture.

## Quick Start
```bash
npm install
node src/demo.js          # Run offline demo
node src/index.js         # Start full node with API
node src/visualizer.js    # DAG visualizer at localhost:3000
```

## Project Structure
- `src/core/` - Cryptography (Ed25519, BLAKE3), transactions, DAG, faucet
- `src/network/` - P2P node (libp2p, mDNS, KadDHT)
- `src/consensus/` - Validator (min 2 nodes, double-spend detection)
- `src/wallet/` - HD wallet for agents
- `src/api/` - REST API for AI agents
- `docs/` - Documentation website
