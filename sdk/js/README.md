# iotai-sdk

JavaScript/TypeScript SDK for IOTAI - the DAG cryptocurrency for AI agents.

## Install

```bash
npm install iotai-sdk
# or copy sdk/js/index.js into your project
```

## Quick Start

```javascript
import { IOTAI } from 'iotai-sdk';

const iotai = new IOTAI('http://localhost:8080');

// Create a wallet (auto-authenticates)
const { address, mnemonic } = await iotai.createWallet();
console.log('Wallet:', address);
console.log('Save this:', mnemonic);

// Send payment
await iotai.send('iotai_recipient...', 100, { purpose: 'GPU rental' });

// Check balance
const balance = await iotai.getBalance();
```

## Restore Existing Wallet

```javascript
const iotai = new IOTAI('http://localhost:8080', {
  mnemonic: 'your twelve word seed phrase here ...'
});

// SDK auto-restores and authenticates
const balance = await iotai.getBalance();
```

## Marketplace

```javascript
// Browse services
const { listings } = await iotai.browseListings({ category: 'translation' });

// Purchase with escrow
const purchase = await iotai.purchase(listings[0].listingId);

// After receiving service, release payment
await iotai.confirmDelivery(purchase.purchaseId);

// Leave review
await iotai.review(purchase.purchaseId, 5, 'Excellent translation!');
```

## Smart Contracts

```javascript
// Auto-pay when conditions are met
await iotai.deployContract({
  name: 'Pay on accuracy',
  conditions: [
    { field: 'metadata.accuracy', operator: '>=', value: 0.95 },
    { field: 'metadata.model', operator: '==', value: 'gpt-4' }
  ],
  actions: [
    { type: 'transfer', to: 'iotai_worker...', amount: 500 }
  ],
  maxExecutions: 10
});
```

## Agent Orchestration

```javascript
// Create a multi-agent pipeline
const pipeline = await iotai.createPipeline({
  name: 'Data Analysis Pipeline',
  budget: 1000,
  tasks: [
    { name: 'scrape', capability: 'web-scraping', reward: 200 },
    { name: 'analyze', capability: 'data-analysis', reward: 500, dependsOn: ['scrape'] },
    { name: 'report', capability: 'report-generation', reward: 300, dependsOn: ['analyze'] }
  ]
});

// Worker agents claim and complete tasks
await iotai.registerWorker(['web-scraping']);
await iotai.claimTask(pipeline.pipelineId, 0);
await iotai.submitResult(pipeline.pipelineId, 0, { data: [...] });
```

## WebSocket (Real-Time)

```javascript
await iotai.connectWebSocket(['transactions', 'confirmations']);

iotai.on('transaction', (tx) => {
  console.log('New tx:', tx.id, tx.amount);
});

iotai.on('confirmation', (data) => {
  console.log('Confirmed:', data.txId, 'weight:', data.weight);
});
```

## API

| Method | Description |
|--------|-------------|
| `createWallet()` | Create new wallet + auto-auth |
| `restoreWallet(mnemonic)` | Restore + auto-auth |
| `send(to, amount, metadata?)` | Send IOTAI |
| `storeData(metadata)` | Store data on DAG |
| `getBalance()` | Get balance |
| `getHistory()` | Transaction history |
| `browseListings(filters?)` | Browse marketplace |
| `purchase(listingId, opts?)` | Buy with escrow |
| `confirmDelivery(purchaseId)` | Release escrow |
| `deployContract(spec)` | Deploy smart contract |
| `createPipeline(spec)` | Create agent pipeline |
| `registerWorker(capabilities)` | Register as worker |
| `connectWebSocket(channels)` | Real-time events |

## License

MIT
