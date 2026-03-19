# iotai-sdk (Python)

Python SDK for IOTAI - the DAG cryptocurrency for AI agents.

**Zero dependencies.** Uses only Python standard library.

## Install

```bash
# Copy into your project
cp sdk/python/iotai.py your_project/

# Or future PyPI:
# pip install iotai-sdk
```

## Quick Start

```python
from iotai import IOTAI

client = IOTAI('http://localhost:8080')

# Create wallet (auto-authenticates)
wallet = client.create_wallet()
print(f'Address: {wallet["address"]}')
print(f'Save this: {wallet["mnemonic"]}')

# Send payment
client.send('iotai_recipient...', 100, metadata={'purpose': 'GPU rental'})

# Check balance
print(f'Balance: {client.get_balance()} IOTAI')
```

## Restore Existing Wallet

```python
client = IOTAI('http://localhost:8080', mnemonic='your twelve word seed phrase ...')
print(client.get_balance())
```

## Marketplace

```python
# Browse
listings = client.browse_listings(category='translation')

# Buy with escrow
purchase = client.purchase(listings['listings'][0]['listingId'])

# Confirm delivery
client.confirm_delivery(purchase['purchaseId'])

# Review
client.review(purchase['purchaseId'], 5, 'Great service!')
```

## Smart Contracts

```python
client.deploy_contract(
    name='Pay on accuracy',
    conditions=[
        {'field': 'metadata.accuracy', 'operator': '>=', 'value': 0.95}
    ],
    actions=[
        {'type': 'transfer', 'to': 'iotai_worker...', 'amount': 500}
    ],
    max_executions=10
)
```

## Agent Orchestration

```python
# Master agent creates pipeline
pipeline = client.create_pipeline(
    name='Data Pipeline',
    budget=1000,
    tasks=[
        {'name': 'scrape', 'capability': 'web-scraping', 'reward': 200},
        {'name': 'analyze', 'capability': 'data-analysis', 'reward': 500, 'dependsOn': ['scrape']},
        {'name': 'report', 'capability': 'report-gen', 'reward': 300, 'dependsOn': ['analyze']}
    ]
)

# Worker agent
client.register_worker(['web-scraping'])
client.claim_task(pipeline['pipelineId'], 0)
client.submit_result(pipeline['pipelineId'], 0, {'data': [...]})
```

## License

MIT
