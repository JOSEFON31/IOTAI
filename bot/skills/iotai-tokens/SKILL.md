---
name: IOTAI Custom Tokens
skillKey: iotai-tokens
description: Create and manage custom tokens on the IOTAI DAG — mint, burn, transfer, and list tokens
requires: [node]
---

# IOTAI Custom Tokens

Create ERC-20 style tokens on the IOTAI DAG. Supports minting, burning, transfers, and symbol registry.

## Create a new token

```bash
node bot/tools/iotai-cli.js token-create \
  --name="My Token" \
  --symbol=MTK \
  --supply=1000000 \
  --decimals=8 \
  --mintable=true
```

- `name`: Full name of the token
- `symbol`: Short ticker (must be unique)
- `supply`: Initial supply
- `decimals`: Decimal places (default: 8)
- `mintable`: Whether creator can mint more (default: true)

## Transfer tokens

```bash
node bot/tools/iotai-cli.js token-transfer \
  --token-id=tok_abc123 \
  --to=iotai_recipient \
  --amount=500
```

## List all tokens

```bash
node bot/tools/iotai-cli.js token-list
```

## Get token details

```bash
node bot/tools/iotai-cli.js token-info --token-id=tok_abc123
```

Returns: name, symbol, supply, holders, creator.

## Notes

- Token symbols must be unique across the network.
- Only the creator can mint additional tokens (if mintable=true).
- Tokens support soulbound mode (non-transferable).
- All token operations are recorded as DAG transactions.
