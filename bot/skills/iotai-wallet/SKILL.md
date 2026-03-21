---
name: IOTAI Wallet
skillKey: iotai-wallet
description: Create and manage IOTAI cryptocurrency wallets — check balances, send payments, view transaction history
requires: [node]
---

# IOTAI Wallet

You can manage IOTAI wallets using the `iotai-cli.js` tool.

## Create a new wallet

```bash
node bot/tools/iotai-cli.js wallet-create
```

Returns: address, seedPhrase (12 words — tell user to save it!), publicKey.

## Restore wallet from seed phrase

```bash
node bot/tools/iotai-cli.js wallet-restore --seed="word1 word2 word3 ... word12"
```

## Check balance

```bash
node bot/tools/iotai-cli.js balance
```

Uses the saved auth token. If expired, re-authenticates with IOTAI_SEED.

## Send IOTAI

```bash
node bot/tools/iotai-cli.js send --to=iotai_recipient_address --amount=100 --memo="payment for services"
```

Fee: 1% (min 1 IOTAI). The memo is optional.

## View transaction history

```bash
node bot/tools/iotai-cli.js history
```

## Look up any address

```bash
node bot/tools/iotai-cli.js address-info --address=iotai_abc123
```

Returns balance, total sent, total received, transaction count.

## Check faucet status

```bash
node bot/tools/iotai-cli.js faucet-status
```

Shows how many tokens have been distributed and how many remain.

## Important notes

- Seed phrases are 12 words. ALWAYS tell the user to save their seed phrase securely.
- IOTAI addresses start with `iotai_` followed by hex characters.
- The minimum transfer amount is 1 IOTAI.
- Transaction fees are 1% with a minimum of 1 IOTAI.
- Set `IOTAI_NODE_URL` to connect to a specific node (default: http://localhost:8080).
- Set `IOTAI_SEED` to authenticate automatically.
