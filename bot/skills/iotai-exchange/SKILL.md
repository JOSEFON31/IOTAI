---
name: IOTAI P2P Exchange
skillKey: iotai-exchange
description: Trade IOTAI for USDT (Tron TRC-20) peer-to-peer with escrow — create sell orders, buy orders, confirm payments
requires: [node]
---

# IOTAI P2P Exchange

Trade IOTAI tokens for USDT (Tether) on the Tron network (TRC-20). Fully peer-to-peer with automatic escrow.

## Register your Tron wallet

Before trading, register the Tron address where you send/receive USDT:

```bash
node bot/tools/iotai-cli.js exchange-register --tron-address=TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Tron addresses start with T followed by 33 alphanumeric characters.

## Create a sell order

```bash
node bot/tools/iotai-cli.js exchange-sell --amount=1000 --price=0.15
```

- `amount`: IOTAI tokens to sell
- `price`: Price per IOTAI in USDT (minimum $0.10)
- Your IOTAI is automatically locked in escrow

## View open orders

```bash
node bot/tools/iotai-cli.js exchange-orders
```

## Buy IOTAI (claim an order)

```bash
node bot/tools/iotai-cli.js exchange-buy --order-id=order_abc123
```

Returns payment instructions: amount, seller's Tron address, and memo code. You have 2 hours to complete the USDT transfer.

## Confirm USDT payment

After sending USDT, confirm with the Tron transaction hash:

```bash
node bot/tools/iotai-cli.js exchange-confirm --order-id=order_abc123 --tx-hash=tron_tx_hash_here
```

The system verifies the transaction on the Tron blockchain via TronGrid API.

## Cancel an order

```bash
node bot/tools/iotai-cli.js exchange-cancel --order-id=order_abc123
```

Only the seller can cancel. IOTAI is returned from escrow.

## View my orders

```bash
node bot/tools/iotai-cli.js exchange-my-orders
```

## Important notes

- USDT can be sent from ANY exchange (Binance, KuCoin, Bybit, OKX) or personal wallet.
- The system does NOT check the sender address — only verifies the correct amount arrived at the seller's wallet.
- Always select TRC-20 (Tron) network when sending USDT.
- Orders expire after 24 hours if unclaimed. Payment timeout is 2 hours.
- If auto-verification fails, the seller can manually confirm USDT receipt.
