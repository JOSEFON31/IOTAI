---
name: IOTAI Node Management
skillKey: iotai-node
description: Monitor and manage an IOTAI node — view network stats, peers, sync status
requires: [node]
---

# IOTAI Node Management

Monitor and manage the connected IOTAI node.

## Network statistics

```bash
node bot/tools/iotai-cli.js node-stats
```

Returns: total transactions, tip count, connected peers, supply info.

## View connected peers

```bash
node bot/tools/iotai-cli.js node-peers
```

## Add a new peer

```bash
node bot/tools/iotai-cli.js node-add-peer --url=https://iotai-node2.onrender.com
```

## Force sync with peers

```bash
node bot/tools/iotai-cli.js node-sync
```

Triggers immediate sync with all connected peers.

## Notes

- Nodes auto-sync every 30-60 seconds.
- Default node URL: http://localhost:8080 (configurable via IOTAI_NODE_URL).
- The IOTAI network uses a DAG (Directed Acyclic Graph) architecture — not a blockchain.
- Each transaction validates 2 parent transactions, creating a self-reinforcing mesh.
