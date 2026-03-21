/**
 * IOTAI P2P Exchange
 *
 * Sell IOTAI for USDT (TRC-20 on Tron network).
 * - Sellers create sell orders, IOTAI goes to escrow
 * - Buyers claim orders, transfer USDT, confirm payment
 * - Platform verifies Tron transaction via TronGrid API
 * - On verification, IOTAI released to buyer
 *
 * USDT Contract (Tron): TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
 */

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API = 'https://api.trongrid.io';
const MIN_PRICE_PER_IOTAI = 0.1; // minimum 0.1 USDT per IOTAI
const ESCROW_PREFIX = 'iotai_exchange_';

// Base58 decode for Tron addresses (T... → 41... hex)
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function tronBase58ToHex(addr) {
  let num = 0n;
  for (const c of addr) {
    const i = BASE58_CHARS.indexOf(c);
    if (i < 0) return addr;
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  // Tron address is 21 bytes (42 hex chars) — pad if needed
  while (hex.length < 50) hex = '0' + hex;
  // Return the 20-byte address part (skip first byte 0x41, skip last 4 bytes checksum)
  return '41' + hex.substring(2, 42);
}
const ORDER_EXPIRY = 24 * 60 * 60 * 1000; // 24h
const PAYMENT_TIMEOUT = 2 * 60 * 60 * 1000; // 2h to pay after claiming

export class Exchange {
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, object>} orderId -> order */
    this.orders = new Map();
    /** @type {Map<string, string>} address -> tronAddress */
    this.usdcWallets = new Map();

    this._rebuildIndex();
  }

  // ============================================================
  // USDT WALLET REGISTRATION
  // ============================================================

  registerUsdcWallet(wallet, tips, { tronAddress }) {
    if (!tronAddress) throw new Error('Tron address required');
    if (!/^T[a-zA-Z0-9]{33}$/.test(tronAddress)) {
      throw new Error('Invalid Tron address format (must start with T, 34 chars)');
    }

    const metadata = {
      _exchange: 'register_wallet',
      tronAddress,
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this.usdcWallets.set(wallet.address, tronAddress);
    return { txId: tx.id, tronAddress };
  }

  getUsdcWallet(address) {
    return this.usdcWallets.get(address) || null;
  }

  // ============================================================
  // SELL ORDERS
  // ============================================================

  createOrder(wallet, tips, { amountIotai, pricePerIotai }) {
    if (!amountIotai || amountIotai <= 0) throw new Error('Amount must be positive');
    if (!pricePerIotai || pricePerIotai < MIN_PRICE_PER_IOTAI) {
      throw new Error(`Minimum price is ${MIN_PRICE_PER_IOTAI} USDT per IOTAI`);
    }

    const sellerTron = this.usdcWallets.get(wallet.address);
    if (!sellerTron) throw new Error('Register your USDT wallet first');

    // Check seller balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < amountIotai) throw new Error('Insufficient IOTAI balance');

    const orderId = this._generateId();
    const escrowAddress = ESCROW_PREFIX + orderId;
    const totalUsdc = Math.round(amountIotai * pricePerIotai * 100) / 100;

    // Lock IOTAI in escrow
    const escrowTx = wallet.send(escrowAddress, amountIotai, tips, {
      _exchange: 'escrow_lock',
      orderId,
      purpose: 'exchange_escrow',
    });
    const escrowResult = this.dag.addTransaction(escrowTx);
    if (!escrowResult.success) throw new Error(escrowResult.error);

    // Create order record
    const metadata = {
      _exchange: 'create_order',
      orderId,
      seller: wallet.address,
      sellerTron,
      amountIotai,
      pricePerIotai,
      totalUsdc,
      escrowAddress,
      status: 'open',
      createdAt: Date.now(),
      expiresAt: Date.now() + ORDER_EXPIRY,
    };

    const tips2 = this.dag.selectTips();
    const tx = wallet.sendData(tips2, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexOrder(tx);
    return { orderId, txId: tx.id, amountIotai, pricePerIotai, totalUsdc, escrowAddress };
  }

  cancelOrder(wallet, tips, { orderId }) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.seller !== wallet.address) throw new Error('Only seller can cancel');
    if (order.status !== 'open') throw new Error('Order cannot be cancelled (status: ' + order.status + ')');

    // Refund escrow
    const escrowBalance = this.dag.getBalance(order.escrowAddress);
    if (escrowBalance > 0) {
      const escrowWallet = { address: order.escrowAddress, send: null };
      // Direct balance transfer for escrow refund
      this.dag.balances.set(order.escrowAddress, 0);
      this.dag.balances.set(wallet.address, (this.dag.getBalance(wallet.address) || 0) + escrowBalance);
    }

    const metadata = {
      _exchange: 'cancel_order',
      orderId,
      author: wallet.address,
      cancelledAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    this.dag.addTransaction(tx);

    order.status = 'cancelled';
    return { orderId, status: 'cancelled', refunded: escrowBalance || order.amountIotai };
  }

  // ============================================================
  // BUY FLOW
  // ============================================================

  claimOrder(wallet, tips, { orderId }) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error('Order not available (status: ' + order.status + ')');
    if (order.seller === wallet.address) throw new Error('Cannot buy your own order');

    const buyerTron = this.usdcWallets.get(wallet.address);
    if (!buyerTron) throw new Error('Register your USDT wallet first');

    // Check if order expired
    if (Date.now() > order.expiresAt) {
      order.status = 'expired';
      throw new Error('Order has expired');
    }

    // Generate unique memo code
    const memoCode = 'IOTAI-' + orderId.toUpperCase().slice(-8);

    const metadata = {
      _exchange: 'claim_order',
      orderId,
      buyer: wallet.address,
      buyerTron,
      memoCode,
      claimedAt: Date.now(),
      paymentDeadline: Date.now() + PAYMENT_TIMEOUT,
    };

    const tx = wallet.sendData(tips, metadata);
    this.dag.addTransaction(tx);

    order.status = 'claimed';
    order.buyer = wallet.address;
    order.buyerTron = buyerTron;
    order.memoCode = memoCode;
    order.claimedAt = Date.now();
    order.paymentDeadline = Date.now() + PAYMENT_TIMEOUT;

    return {
      orderId,
      status: 'claimed',
      memoCode,
      payTo: order.sellerTron,
      totalUsdc: order.totalUsdc,
      amountIotai: order.amountIotai,
      paymentDeadline: order.paymentDeadline,
      instructions: `Transfer ${order.totalUsdc} USDT (TRC-20) to ${order.sellerTron}. Use memo: ${memoCode}`,
    };
  }

  async confirmPayment(wallet, tips, { orderId, tronTxHash }) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'claimed') throw new Error('Order not in claimed status');
    if (order.buyer !== wallet.address) throw new Error('Only buyer can confirm payment');

    if (!tronTxHash) throw new Error('Tron transaction hash required');

    // Verify on Tron blockchain
    let verified = false;
    let verifyError = null;

    try {
      verified = await this._verifyTronTransaction(tronTxHash, {
        expectedTo: order.sellerTron,
        expectedAmount: order.totalUsdc,
      });
    } catch (e) {
      verifyError = e.message;
    }

    if (!verified) {
      // Save as pending manual review
      const metadata = {
        _exchange: 'payment_pending',
        orderId,
        tronTxHash,
        verifyError: verifyError || 'Transaction not verified',
        buyer: wallet.address,
        submittedAt: Date.now(),
      };

      const tx = wallet.sendData(tips, metadata);
      this.dag.addTransaction(tx);

      order.status = 'pending_verification';
      order.tronTxHash = tronTxHash;

      return {
        orderId,
        status: 'pending_verification',
        message: 'Payment submitted. Verification pending. Seller will be notified.',
        tronTxHash,
      };
    }

    // Verified! Release IOTAI to buyer
    return this._releaseIotai(order, tronTxHash, tips);
  }

  sellerConfirmPayment(wallet, tips, { orderId }) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.seller !== wallet.address) throw new Error('Only seller can confirm');
    if (order.status !== 'pending_verification' && order.status !== 'claimed') {
      throw new Error('Order not awaiting confirmation');
    }

    return this._releaseIotai(order, order.tronTxHash || 'seller_confirmed', tips);
  }

  _releaseIotai(order, tronTxHash, tips) {
    // Transfer IOTAI from escrow to buyer
    const escrowBalance = this.dag.getBalance(order.escrowAddress);
    if (escrowBalance <= 0) throw new Error('Escrow is empty');

    // Direct balance transfer (escrow -> buyer)
    this.dag.balances.set(order.escrowAddress, 0);
    const buyerBalance = this.dag.getBalance(order.buyer) || 0;
    this.dag.balances.set(order.buyer, buyerBalance + escrowBalance);

    order.status = 'completed';
    order.tronTxHash = tronTxHash;
    order.completedAt = Date.now();

    return {
      orderId: order.orderId,
      status: 'completed',
      amountIotai: order.amountIotai,
      totalUsdc: order.totalUsdc,
      buyer: order.buyer,
      seller: order.seller,
      tronTxHash,
    };
  }

  // ============================================================
  // TRON VERIFICATION
  // ============================================================

  async _verifyTronTransaction(txHash, { expectedTo, expectedAmount }) {
    try {
      const res = await fetch(`${TRONGRID_API}/v1/transactions/${txHash}`);
      if (!res.ok) return false;

      const data = await res.json();
      if (!data?.data?.[0]) return false;

      const txInfo = data.data[0];

      // Check if confirmed
      if (txInfo.ret?.[0]?.contractRet !== 'SUCCESS') return false;

      // For TRC-20 USDT, check internal transactions
      const res2 = await fetch(`${TRONGRID_API}/v1/transactions/${txHash}/events`);
      if (!res2.ok) return false;

      const events = await res2.json();
      if (!events?.data) return false;

      // Look for Transfer event from USDT contract
      // NOTE: We only verify destination + amount, NOT the sender address.
      // This allows payments from exchanges (Binance, KuCoin, etc.) which
      // use pool/hot wallets, so the sender address won't match the buyer's
      // registered Tron address.
      for (const event of events.data) {
        if (event.contract_address !== USDT_CONTRACT) continue;
        if (event.event_name !== 'Transfer') continue;

        const toAddr = event.result?.to || event.result?.['1'];
        const amount = event.result?.value || event.result?.['2'];

        if (!toAddr || !amount) continue;

        // Verify destination is the seller's Tron wallet (hex → base58 comparison)
        // TronGrid returns addresses in hex format (41...), convert to match
        const toHex = toAddr.toLowerCase().replace(/^0x/, '');
        const expectedHex = expectedTo ? tronBase58ToHex(expectedTo).toLowerCase() : null;
        const destMatch = !expectedTo || toHex === expectedHex || toAddr === expectedTo;

        if (!destMatch) continue;

        // Convert amount (USDT has 6 decimals on Tron)
        const usdtAmount = parseInt(amount) / 1_000_000;

        // Allow 1% tolerance for fees
        const amountMatch = usdtAmount >= expectedAmount * 0.99;

        if (amountMatch) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  // ============================================================
  // QUERIES
  // ============================================================

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  getOpenOrders({ limit = 20, offset = 0 } = {}) {
    const orders = [...this.orders.values()]
      .filter(o => o.status === 'open' && Date.now() < o.expiresAt)
      .sort((a, b) => a.pricePerIotai - b.pricePerIotai); // cheapest first
    return orders.slice(offset, offset + limit);
  }

  getMyOrders(address) {
    return [...this.orders.values()]
      .filter(o => o.seller === address || o.buyer === address)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getStats() {
    const orders = [...this.orders.values()];
    const completed = orders.filter(o => o.status === 'completed');
    const totalVolume = completed.reduce((s, o) => s + o.totalUsdc, 0);
    const avgPrice = completed.length > 0
      ? completed.reduce((s, o) => s + o.pricePerIotai, 0) / completed.length
      : 0;

    return {
      totalOrders: orders.length,
      openOrders: orders.filter(o => o.status === 'open').length,
      completedTrades: completed.length,
      totalVolumeUsdc: Math.round(totalVolume * 100) / 100,
      avgPriceUsdc: Math.round(avgPrice * 10000) / 10000,
      registeredWallets: this.usdcWallets.size,
    };
  }

  // ============================================================
  // EXPIRY PROCESSING
  // ============================================================

  processExpired() {
    let expired = 0;
    let released = 0;

    for (const order of this.orders.values()) {
      // Expire open orders past expiry time
      if (order.status === 'open' && Date.now() > order.expiresAt) {
        order.status = 'expired';
        // Refund escrow
        const escrowBalance = this.dag.getBalance(order.escrowAddress);
        if (escrowBalance > 0) {
          this.dag.balances.set(order.escrowAddress, 0);
          const sellerBal = this.dag.getBalance(order.seller) || 0;
          this.dag.balances.set(order.seller, sellerBal + escrowBalance);
        }
        expired++;
      }

      // Release claimed orders past payment deadline
      if (order.status === 'claimed' && Date.now() > order.paymentDeadline) {
        order.status = 'expired';
        const escrowBalance = this.dag.getBalance(order.escrowAddress);
        if (escrowBalance > 0) {
          this.dag.balances.set(order.escrowAddress, 0);
          const sellerBal = this.dag.getBalance(order.seller) || 0;
          this.dag.balances.set(order.seller, sellerBal + escrowBalance);
        }
        released++;
      }
    }

    return { expired, released };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  /** Re-index orderbook from DAG (called after P2P sync imports new txs) */
  resync() { this._rebuildIndex(); }

  _rebuildIndex() {
    this.orders.clear();
    this.usdcWallets.clear();

    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._exchange)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._exchange) {
        case 'register_wallet': this._indexWallet(tx); break;
        case 'create_order': this._indexOrder(tx); break;
        case 'cancel_order': this._indexCancel(tx); break;
        case 'claim_order': this._indexClaim(tx); break;
        case 'escrow_lock': break; // handled by balance system
      }
    }

    const stats = this.getStats();
    if (stats.totalOrders > 0) {
      console.log(`[Exchange] Indexed ${stats.totalOrders} orders, ${stats.completedTrades} trades`);
    }
  }

  _indexWallet(tx) {
    const m = tx.metadata;
    this.usdcWallets.set(m.author || tx.from, m.tronAddress);
  }

  _indexOrder(tx) {
    const m = tx.metadata;
    this.orders.set(m.orderId, {
      orderId: m.orderId,
      txId: tx.id,
      seller: m.seller,
      sellerTron: m.sellerTron,
      amountIotai: m.amountIotai,
      pricePerIotai: m.pricePerIotai,
      totalUsdc: m.totalUsdc,
      escrowAddress: m.escrowAddress,
      status: m.status || 'open',
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      buyer: null,
      buyerTron: null,
      memoCode: null,
    });
  }

  _indexCancel(tx) {
    const order = this.orders.get(tx.metadata.orderId);
    if (order) order.status = 'cancelled';
  }

  _indexClaim(tx) {
    const m = tx.metadata;
    const order = this.orders.get(m.orderId);
    if (order) {
      order.status = 'claimed';
      order.buyer = m.buyer;
      order.buyerTron = m.buyerTron;
      order.memoCode = m.memoCode;
      order.claimedAt = m.claimedAt;
      order.paymentDeadline = m.paymentDeadline;
    }
  }

  _generateId() {
    return 'ex_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
