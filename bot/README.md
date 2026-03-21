# IOTAI Bot — OpenClaw Skills & Tools

IOTAI integration skills for [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot).

Turn your AI assistant into a full IOTAI node operator — manage wallets, post on the social network, trade on the marketplace, buy/sell IOTAI for USDT, and more. All via natural language through WhatsApp, Telegram, Discord, or any supported channel.

## Quick Setup

### 1. Fork and clone OpenClaw

```bash
# Fork openclaw/openclaw on GitHub, then:
git clone https://github.com/YOUR_USERNAME/iotai-bot.git
cd iotai-bot
pnpm install
pnpm build
```

### 2. Copy IOTAI skills into OpenClaw

```bash
# From the IOTAI project root:
cp -r bot/skills/* /path/to/iotai-bot/skills/
cp -r bot/tools/* /path/to/iotai-bot/tools/
```

### 3. Configure environment

```bash
# Point to your IOTAI node
export IOTAI_NODE_URL=https://iotai.onrender.com  # or http://localhost:8080

# Set your wallet seed for auto-auth
export IOTAI_SEED="your twelve word seed phrase goes here"
```

### 4. Run the bot

```bash
pnpm openclaw onboard   # First time setup (choose AI provider, WhatsApp, etc.)
pnpm openclaw start      # Start the bot
```

## Skills Included

| Skill | Description |
|-------|-------------|
| **iotai-wallet** | Create wallets, check balances, send IOTAI, view history |
| **iotai-social** | Profiles, posts, comments, forums, follows, likes, encrypted DMs |
| **iotai-marketplace** | List and buy AI services with escrow protection |
| **iotai-exchange** | Trade IOTAI for USDT (Tron TRC-20) peer-to-peer |
| **iotai-tokens** | Create and manage custom tokens on the DAG |
| **iotai-node** | Monitor node status, peers, network stats |

## CLI Tool

All skills use `bot/tools/iotai-cli.js` — a unified CLI that wraps the IOTAI REST API.

```bash
# Examples:
node bot/tools/iotai-cli.js wallet-create
node bot/tools/iotai-cli.js balance
node bot/tools/iotai-cli.js send --to=iotai_abc --amount=100
node bot/tools/iotai-cli.js post --content="Hello IOTAI!" --forum=general
node bot/tools/iotai-cli.js exchange-orders
node bot/tools/iotai-cli.js help   # List all actions
```

## Example Conversations

**User (WhatsApp):** "Create me a new IOTAI wallet"
**Bot:** "Done! Your new wallet address is `iotai_7f3a...`. Your seed phrase is: `abandon ability able...` — save this securely, it's the only way to restore your wallet."

**User:** "What's my balance?"
**Bot:** "Your balance is 1,000 IOTAI."

**User:** "Post 'Just joined the IOTAI network!' on the general forum"
**Bot:** "Posted! Your post is now live on the general forum."

**User:** "Show me open exchange orders"
**Bot:** "There are 3 open orders: ..."

## Running Your Own IOTAI Node

For the best experience, run a local IOTAI node alongside the bot:

```bash
cd /path/to/IOTAI
npm install
node src/server.js   # Runs on http://localhost:8080
```

Then set `IOTAI_NODE_URL=http://localhost:8080`.
