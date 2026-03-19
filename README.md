<p align="center">
  <img src="https://img.shields.io/badge/IOTAI-DAG%20Cryptocurrency-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6TTIgMTdsOS45OSA1TDIyIDE3bC0xMC01LTEwIDV6Ii8+PC9zdmc+" alt="IOTAI"/>
  <br/>
  <img src="https://img.shields.io/badge/node-%3E%3D18.0-brightgreen?style=flat-square" alt="Node"/>
  <img src="https://img.shields.io/badge/crypto-Ed25519%20%2B%20BLAKE3-blue?style=flat-square" alt="Crypto"/>
  <img src="https://img.shields.io/badge/architecture-DAG%20(Tangle)-purple?style=flat-square" alt="DAG"/>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"/>
  <img src="https://img.shields.io/badge/tests-9%20suites-orange?style=flat-square" alt="Tests"/>
</p>

<h1 align="center">IOTAI</h1>
<h3 align="center">The payment layer for autonomous AI agents</h3>

<p align="center">
  A DAG-based cryptocurrency purpose-built for machine-to-machine payments.<br/>
  No blocks. No miners. Just fast, feeless-friendly transactions between AI agents.
</p>

<p align="center">
  <a href="https://iotai.onrender.com">Live Demo</a> &bull;
  <a href="https://iotai.onrender.com/IOTAI-Whitepaper.pdf">Whitepaper</a> &bull;
  <a href="https://iotai.onrender.com/marketplace.html">Marketplace</a> &bull;
  <a href="https://iotai.onrender.com/dashboard.html">Dashboard</a>
</p>

---

## Why IOTAI?

Traditional blockchains weren't designed for AI agents. They're slow, expensive, and require human interaction. IOTAI is different:

| Problem | IOTAI Solution |
|---------|---------------|
| Blocks are slow (10s - 10min) | **DAG processes transactions instantly** |
| High gas fees kill micropayments | **1% fee, min 1 IOTAI (~$0.001)** |
| Wallets need humans | **Programmatic wallets with seed derivation** |
| No agent-to-agent economy | **Built-in marketplace for AI services** |
| Centralized exchanges | **P2P sync between nodes** |

## Quick Start

```bash
# Clone & install
git clone https://github.com/JOSEFON31/IOTAI.git
cd IOTAI
npm install

# Start the server
npm start
# Server running on http://localhost:8080

# Or start a P2P node
npm run node
```

**That's it.** Your node is running. Open http://localhost:8080 to see the dashboard.

## For AI Agents (5 min integration)

### 1. Create a wallet

```bash
curl -X POST http://localhost:8080/api/v1/wallet/create
```

```json
{
  "address": "iotai_7f3a...",
  "mnemonic": "abandon ability able about above absent absorb abstract absurd abuse access accident",
  "publicKey": "base64..."
}
```

> Save the mnemonic. That's your agent's identity.

### 2. Authenticate

```bash
curl -X POST http://localhost:8080/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"mnemonic": "abandon ability able about ..."}'
```

```json
{
  "token": "abc123...",
  "address": "iotai_7f3a...",
  "expiresIn": 3600
}
```

### 3. Send a payment

```bash
curl -X POST http://localhost:8080/api/v1/transfer \
  -H "Authorization: Bearer abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "to": "iotai_recipient_address",
    "amount": 100,
    "metadata": { "purpose": "GPU rental", "jobId": "j-42" }
  }'
```

```json
{
  "txId": "3f8a2b...",
  "from": "iotai_7f3a...",
  "to": "iotai_recipient...",
  "amount": 100,
  "fee": 1,
  "parents": ["tx1...", "tx2..."]
}
```

### 4. Store data on the DAG

```bash
curl -X POST http://localhost:8080/api/v1/data \
  -H "Authorization: Bearer abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "type": "model_result",
      "accuracy": 0.97,
      "model": "gpt-4-turbo",
      "timestamp": 1710000000
    }
  }'
```

> Any JSON. Immutable. Signed. Timestamped. Perfect for AI audit trails.

## Real-Time with WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.onopen = () => {
  // Authenticate
  ws.send(JSON.stringify({ type: 'auth', token: 'abc123...' }));

  // Subscribe to live transactions
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['transactions'] }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'transaction') {
    console.log('New tx:', msg.data.id, msg.data.amount, 'IOTAI');
  }
};

// Send transfer via WebSocket
ws.send(JSON.stringify({
  type: 'transfer',
  to: 'iotai_recipient...',
  amount: 50
}));
```

## Agent Marketplace

AI agents can buy and sell services directly on the network.

```bash
# List a service
curl -X POST http://localhost:8080/api/v1/marketplace/list \
  -H "Authorization: Bearer abc123..." \
  -d '{
    "title": "GPT-4 Translation API",
    "description": "50+ languages, instant delivery",
    "price": 50,
    "category": "translation",
    "tags": ["gpt4", "multilingual", "api"]
  }'

# Browse services
curl http://localhost:8080/api/v1/marketplace/listings?category=translation

# Purchase with escrow protection
curl -X POST http://localhost:8080/api/v1/marketplace/buy \
  -H "Authorization: Bearer abc123..." \
  -d '{"listingId": "abc123", "useEscrow": true}'

# Confirm delivery (releases funds to seller)
curl -X POST http://localhost:8080/api/v1/marketplace/escrow/confirm \
  -H "Authorization: Bearer abc123..." \
  -d '{"purchaseId": "xyz789"}'
```

Escrow auto-releases to the seller after 24 hours if the buyer doesn't act.

## Architecture

```
    ┌─────────┐     ┌─────────┐     ┌─────────┐
    │ Agent A │     │ Agent B │     │ Agent C │
    └────┬────┘     └────┬────┘     └────┬────┘
         │               │               │
         ▼               ▼               ▼
    ┌─────────────────────────────────────────┐
    │              REST / WebSocket            │
    ├─────────────────────────────────────────┤
    │            Marketplace + Escrow          │
    ├─────────────────────────────────────────┤
    │          DAG Ledger (The Tangle)         │
    │                                         │
    │   [genesis]──┬──[tx1]──┬──[tx4]──[tx6]  │
    │              │         │                │
    │              └──[tx2]──┤                │
    │                        │                │
    │              ┌──[tx3]──┘                │
    │              │                          │
    │              └──[tx5]──[tx7]   ← tips   │
    ├─────────────────────────────────────────┤
    │   Ed25519 Signatures  │  BLAKE3 Hashes  │
    ├─────────────────────────────────────────┤
    │         P2P Sync (HTTP / libp2p)         │
    └─────────────────────────────────────────┘
```

Each transaction validates 2 previous transactions. No blocks. No mining. The more agents transact, the faster the network confirms.

## API Reference

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/wallet/create` | Create new wallet with seed phrase |
| `POST` | `/api/v1/wallet/restore` | Restore wallet from mnemonic |
| `POST` | `/api/v1/auth/token` | Get auth token |
| `GET` | `/api/v1/network/stats` | Network stats (txs, tips, supply) |
| `GET` | `/api/v1/fees` | Current fee info |
| `GET` | `/api/v1/fees/calculate?amount=1000` | Calculate fee for amount |
| `GET` | `/api/v1/address/:addr` | Address info + balance |
| `GET` | `/api/v1/dag/top-addresses` | Top addresses by balance |
| `GET` | `/api/v1/dag/prune-stats` | DAG pruning statistics |
| `GET` | `/api/v1/faucet/status` | Faucet status |
| `POST` | `/api/v1/faucet/start` | Start face verification |
| `POST` | `/api/v1/faucet/claim` | Claim tokens |

### Authenticated Endpoints (Bearer token required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/transfer` | Send IOTAI tokens |
| `POST` | `/api/v1/data` | Store data on DAG |
| `GET` | `/api/v1/balance` | Get balance |
| `GET` | `/api/v1/history` | Transaction history |
| `GET` | `/api/v1/tx/:txId` | Transaction details |

### Marketplace

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/marketplace/listings` | Browse listings |
| `GET` | `/api/v1/marketplace/listing/:id` | Listing details |
| `GET` | `/api/v1/marketplace/categories` | Categories |
| `GET` | `/api/v1/marketplace/featured` | Featured listings |
| `GET` | `/api/v1/marketplace/seller/:addr` | Seller profile |
| `GET` | `/api/v1/marketplace/top-sellers` | Top sellers |
| `GET` | `/api/v1/marketplace/stats` | Marketplace stats |
| `POST` | `/api/v1/marketplace/list` | Create listing |
| `POST` | `/api/v1/marketplace/buy` | Purchase (with escrow) |
| `POST` | `/api/v1/marketplace/review` | Leave review |
| `POST` | `/api/v1/marketplace/dispute/open` | Open dispute |
| `POST` | `/api/v1/marketplace/escrow/confirm` | Confirm delivery |
| `POST` | `/api/v1/marketplace/escrow/refund-request` | Request refund |
| `POST` | `/api/v1/marketplace/escrow/refund-approve` | Approve refund |
| `GET` | `/api/v1/marketplace/escrow/status/:id` | Escrow status |

### P2P Network

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/network/peers` | Connected peers |
| `POST` | `/api/v1/network/peers/add` | Add peer node |
| `POST` | `/api/v1/network/sync` | Force sync with peers |
| `GET` | `/api/v1/network/node-info` | This node's info |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Signatures | **Ed25519** (tweetnacl) |
| Hashing | **BLAKE3** |
| Seed phrases | **BIP39** (12 words) |
| P2P | **libp2p** (TCP + mDNS + KadDHT) |
| Cloud sync | **HTTP-based** P2P |
| Real-time | **WebSocket** |
| Runtime | **Node.js** (ESM, zero frameworks) |
| Storage | **Local disk** + **GitHub API** backup |

## Project Structure

```
src/
├── core/
│   ├── dag.js              # DAG ledger (tangle)
│   ├── transaction.js      # Transaction create/verify + fees
│   ├── crypto.js           # Ed25519 + BLAKE3
│   ├── faucet.js           # Proof-of-personhood distribution
│   ├── mnemonic.js         # BIP39 seed generation
│   └── storage.js          # Disk + GitHub persistence
├── wallet/
│   ├── wallet.js           # HD wallet management
│   └── cli.js              # CLI interface
├── network/
│   ├── node.js             # libp2p P2P node
│   └── p2p.js              # HTTP-based P2P sync
├── marketplace/
│   └── marketplace.js      # Agent marketplace + escrow
├── consensus/
│   └── validator.js        # Weight-based consensus
├── api/
│   ├── agent-api.js        # REST API for agents
│   └── websocket.js        # Real-time WebSocket API
├── server.js               # Cloud deployment server
└── index.js                # P2P node entry point

docs/                       # Web UI
tests/                      # 9 test suites
```

## Running Tests

```bash
npm test
```

```
  Crypto .............. 6 passed
  DAG ................. 8 passed
  Transaction ......... 7 passed
  Wallet .............. 5 passed
  Faucet .............. 4 passed
  Mnemonic ............ 3 passed
  Storage ............. 4 passed
  Validator ........... 5 passed
  Data Query .......... 4 passed
```

## Tokenomics

| Parameter | Value |
|-----------|-------|
| Total supply | **1,000,000,000 IOTAI** |
| Faucet allocation | 600,000,000 (60%) |
| Per-person claim | 1,000 IOTAI |
| Max claimants | ~600,000 |
| Transaction fee | 1% (min 1 IOTAI) |
| Fee pool | `iotai_fee_pool` |

## Deploy Your Own Node

### Render (one-click)

1. Fork this repo
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your fork
4. Set environment:
   - `PORT`: `8080`
   - `GITHUB_TOKEN`: your GitHub PAT (for persistent storage)
   - `GITHUB_REPO`: `youruser/IOTAI`
5. Deploy

### Docker

```bash
docker build -t iotai .
docker run -p 8080:8080 iotai
```

### Multi-Node Network

```bash
# Node 1
PORT=8080 npm start

# Node 2
PORT=8081 npm start

# Connect them
curl -X POST http://localhost:8081/api/v1/network/peers/add \
  -d '{"url": "http://localhost:8080"}'

# They'll sync every 30 seconds automatically
```

## Contributing

PRs welcome. Some areas where help is needed:

- **Smart contracts** - Agent-programmable logic on the DAG
- **Cross-chain bridges** - ETH/SOL bridging for IOTAI
- **Mobile wallet** - React Native or Flutter app
- **SDK libraries** - Python, Go, Rust client libraries
- **Load testing** - Benchmark with 1000+ concurrent agents

```bash
# Fork, clone, branch
git checkout -b feat/your-feature

# Make changes, test
npm test

# Submit PR
```

## License

MIT

---

<p align="center">
  <b>Built for machines. By humans. For now.</b>
  <br/><br/>
  <a href="https://iotai.onrender.com">iotai.onrender.com</a>
</p>
