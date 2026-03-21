#!/usr/bin/env node
/**
 * IOTAI CLI Tool — Used by OpenClaw/Moltbot skills to interact with an IOTAI node.
 *
 * Usage: node iotai-cli.js <action> [--key=value ...]
 *
 * Environment:
 *   IOTAI_NODE_URL  — Node API URL (default: http://localhost:8080)
 *   IOTAI_SEED      — Wallet seed phrase for auth (optional, can pass --seed)
 *
 * Examples:
 *   node iotai-cli.js wallet-create
 *   node iotai-cli.js balance
 *   node iotai-cli.js send --to=iotai_abc123 --amount=100
 *   node iotai-cli.js post --content="Hello world" --forum=general
 *   node iotai-cli.js feed-global
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const NODE_URL = process.env.IOTAI_NODE_URL || 'http://localhost:8080';
const CONFIG_DIR = join(homedir(), '.iotai-bot');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

// ---- Helpers ----

function parseArgs() {
  const args = process.argv.slice(2);
  const action = args[0];
  const params = {};
  for (let i = 1; i < args.length; i++) {
    const m = args[i].match(/^--(\w[\w-]*)=(.*)$/);
    if (m) params[m[1]] = m[2];
    else if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      params[key] = args[i + 1] || 'true';
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
    }
  }
  return { action, params };
}

function loadToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (data.expiresAt > Date.now()) return data;
    }
  } catch {}
  return null;
}

function saveToken(token, address, expiresIn) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({
    token, address, expiresAt: Date.now() + (expiresIn || 3600) * 1000
  }));
}

async function api(method, path, body, token) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${NODE_URL}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function authenticate(seed) {
  const saved = loadToken();
  if (saved) return saved;

  if (!seed) {
    seed = process.env.IOTAI_SEED;
  }
  if (!seed) throw new Error('No seed phrase. Set IOTAI_SEED or pass --seed="your 12 words"');

  const words = seed.trim().split(/\s+/);
  let body;
  if (words.length >= 12) {
    body = { mnemonic: seed.trim() };
  } else {
    body = { passphrase: seed.trim() };
  }

  const data = await api('POST', '/api/v1/auth/token', body);
  saveToken(data.token, data.address, data.expiresIn);
  return { token: data.token, address: data.address };
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ---- Actions ----

const actions = {

  // ---- Wallet ----
  async 'wallet-create'() {
    const data = await api('POST', '/api/v1/wallet/create');
    saveToken(data.token, data.address, data.expiresIn);
    out({ address: data.address, seedPhrase: data.seedPhrase, publicKey: data.publicKey });
  },

  async 'wallet-restore'(p) {
    if (!p.seed) throw new Error('--seed required');
    const data = await api('POST', '/api/v1/wallet/restore', { mnemonic: p.seed });
    saveToken(data.token, data.address, data.expiresIn);
    out({ address: data.address, publicKey: data.publicKey });
  },

  async 'balance'(p) {
    const auth = await authenticate(p.seed);
    const data = await api('GET', '/api/v1/balance', null, auth.token);
    out({ address: auth.address, balance: data.balance });
  },

  async 'send'(p) {
    if (!p.to || !p.amount) throw new Error('--to and --amount required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/transfer', {
      to: p.to, amount: Number(p.amount), metadata: p.memo ? { memo: p.memo } : undefined
    }, auth.token);
    out(data);
  },

  async 'history'(p) {
    const auth = await authenticate(p.seed);
    const data = await api('GET', '/api/v1/history', null, auth.token);
    out(data);
  },

  async 'address-info'(p) {
    if (!p.address) throw new Error('--address required');
    const data = await api('GET', `/api/v1/address/${p.address}`);
    out(data);
  },

  // ---- Social ----
  async 'profile-create'(p) {
    if (!p.username) throw new Error('--username required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/profile', {
      username: p.username, displayName: p['display-name'] || p.username, bio: p.bio || ''
    }, auth.token);
    out(data);
  },

  async 'profile-update'(p) {
    const auth = await authenticate(p.seed);
    const body = {};
    if (p['display-name']) body.displayName = p['display-name'];
    if (p.bio) body.bio = p.bio;
    if (p.avatar) body.avatar = p.avatar;
    const data = await api('POST', '/api/v1/social/profile/update', body, auth.token);
    out(data);
  },

  async 'profile-get'(p) {
    if (!p.address && !p.username) throw new Error('--address or --username required');
    const path = p.username
      ? `/api/v1/social/user/${p.username}`
      : `/api/v1/social/profile/${p.address}`;
    const data = await api('GET', path);
    out(data);
  },

  async 'post'(p) {
    if (!p.content) throw new Error('--content required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/post', {
      content: p.content, forum: p.forum || undefined
    }, auth.token);
    out(data);
  },

  async 'comment'(p) {
    if (!p['post-id'] || !p.content) throw new Error('--post-id and --content required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/comment', {
      postId: p['post-id'], content: p.content
    }, auth.token);
    out(data);
  },

  async 'follow'(p) {
    if (!p.address) throw new Error('--address required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/follow', { address: p.address }, auth.token);
    out(data);
  },

  async 'unfollow'(p) {
    if (!p.address) throw new Error('--address required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/unfollow', { address: p.address }, auth.token);
    out(data);
  },

  async 'like'(p) {
    if (!p['post-id']) throw new Error('--post-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/like', { postId: p['post-id'] }, auth.token);
    out(data);
  },

  async 'dislike'(p) {
    if (!p['post-id']) throw new Error('--post-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/social/dislike', { postId: p['post-id'] }, auth.token);
    out(data);
  },

  async 'feed'(p) {
    const auth = await authenticate(p.seed);
    const data = await api('GET', '/api/v1/social/feed', null, auth.token);
    out(data);
  },

  async 'feed-global'() {
    const data = await api('GET', '/api/v1/social/feed/global');
    out(data);
  },

  async 'forums'() {
    const data = await api('GET', '/api/v1/social/forums');
    out(data);
  },

  async 'forum-posts'(p) {
    if (!p['forum-id']) throw new Error('--forum-id required');
    const data = await api('GET', `/api/v1/social/forum/${p['forum-id']}`);
    out(data);
  },

  async 'msg-send'(p) {
    if (!p.to || !p.message) throw new Error('--to and --message required');
    const auth = await authenticate(p.seed);
    try { await api('POST', '/api/v1/encryption/register', {}, auth.token); } catch {}
    const data = await api('POST', '/api/v1/encryption/send', {
      to: p.to, data: p.message, subject: p.subject || ''
    }, auth.token);
    out(data);
  },

  async 'msg-inbox'(p) {
    const auth = await authenticate(p.seed);
    const data = await api('GET', '/api/v1/encryption/inbox', null, auth.token);
    out(data);
  },

  // ---- Marketplace ----
  async 'market-list'(p) {
    const category = p.category ? `?category=${p.category}` : '';
    const data = await api('GET', `/api/v1/marketplace/listings${category}`);
    out(data);
  },

  async 'market-create'(p) {
    if (!p.title || !p.price) throw new Error('--title and --price required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/marketplace/list', {
      title: p.title, description: p.description || '', price: Number(p.price),
      category: p.category || 'general', tags: p.tags ? p.tags.split(',') : []
    }, auth.token);
    out(data);
  },

  async 'market-buy'(p) {
    if (!p['listing-id']) throw new Error('--listing-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/marketplace/buy', {
      listingId: p['listing-id'], useEscrow: p.escrow !== 'false'
    }, auth.token);
    out(data);
  },

  async 'market-confirm'(p) {
    if (!p['purchase-id']) throw new Error('--purchase-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/marketplace/escrow/confirm', {
      purchaseId: p['purchase-id']
    }, auth.token);
    out(data);
  },

  async 'market-review'(p) {
    if (!p['listing-id'] || !p.rating) throw new Error('--listing-id and --rating required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/marketplace/review', {
      listingId: p['listing-id'], rating: Number(p.rating), comment: p.comment || ''
    }, auth.token);
    out(data);
  },

  // ---- Exchange ----
  async 'exchange-register'(p) {
    if (!p['tron-address']) throw new Error('--tron-address required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/exchange/register-wallet', {
      tronAddress: p['tron-address']
    }, auth.token);
    out(data);
  },

  async 'exchange-sell'(p) {
    if (!p.amount || !p.price) throw new Error('--amount and --price required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/exchange/create-order', {
      amount: Number(p.amount), pricePerIotai: Number(p.price)
    }, auth.token);
    out(data);
  },

  async 'exchange-orders'() {
    const data = await api('GET', '/api/v1/exchange/orders');
    out(data);
  },

  async 'exchange-buy'(p) {
    if (!p['order-id']) throw new Error('--order-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/exchange/claim-order', {
      orderId: p['order-id']
    }, auth.token);
    out(data);
  },

  async 'exchange-confirm'(p) {
    if (!p['order-id'] || !p['tx-hash']) throw new Error('--order-id and --tx-hash required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/exchange/confirm-payment', {
      orderId: p['order-id'], txHash: p['tx-hash']
    }, auth.token);
    out(data);
  },

  async 'exchange-cancel'(p) {
    if (!p['order-id']) throw new Error('--order-id required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/exchange/cancel-order', {
      orderId: p['order-id']
    }, auth.token);
    out(data);
  },

  async 'exchange-my-orders'(p) {
    const auth = await authenticate(p.seed);
    const data = await api('GET', '/api/v1/exchange/my-orders', null, auth.token);
    out(data);
  },

  // ---- Tokens ----
  async 'token-create'(p) {
    if (!p.name || !p.symbol || !p.supply) throw new Error('--name, --symbol, --supply required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/tokens/create', {
      name: p.name, symbol: p.symbol, initialSupply: Number(p.supply),
      decimals: Number(p.decimals || 8), mintable: p.mintable !== 'false'
    }, auth.token);
    out(data);
  },

  async 'token-transfer'(p) {
    if (!p['token-id'] || !p.to || !p.amount) throw new Error('--token-id, --to, --amount required');
    const auth = await authenticate(p.seed);
    const data = await api('POST', '/api/v1/tokens/transfer', {
      tokenId: p['token-id'], to: p.to, amount: Number(p.amount)
    }, auth.token);
    out(data);
  },

  async 'token-list'() {
    const data = await api('GET', '/api/v1/tokens');
    out(data);
  },

  async 'token-info'(p) {
    if (!p['token-id']) throw new Error('--token-id required');
    const data = await api('GET', `/api/v1/tokens/${p['token-id']}`);
    out(data);
  },

  // ---- Node ----
  async 'node-stats'() {
    const data = await api('GET', '/api/v1/network/stats');
    out(data);
  },

  async 'node-peers'() {
    const data = await api('GET', '/api/v1/network/peers');
    out(data);
  },

  async 'node-add-peer'(p) {
    if (!p.url) throw new Error('--url required');
    const data = await api('POST', '/api/v1/network/peers/add', { url: p.url });
    out(data);
  },

  async 'node-sync'() {
    const data = await api('POST', '/api/v1/network/sync');
    out(data);
  },

  // ---- Faucet ----
  async 'faucet-status'() {
    const data = await api('GET', '/api/v1/faucet/status');
    out(data);
  },

  // ---- Help ----
  async 'help'() {
    out({
      usage: 'node iotai-cli.js <action> [--key=value ...]',
      node: NODE_URL,
      actions: Object.keys(actions).sort()
    });
  }
};

// ---- Main ----
const { action, params } = parseArgs();

if (!action || !actions[action]) {
  console.error(`Unknown action: ${action || '(none)'}`);
  console.error(`Available: ${Object.keys(actions).sort().join(', ')}`);
  process.exit(1);
}

actions[action](params).catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
