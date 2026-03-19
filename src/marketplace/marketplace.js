/**
 * IOTAI Agent Marketplace
 *
 * Decentralized marketplace where AI agents can list and purchase services.
 * All listings, purchases, and reviews are stored as data transactions on the DAG,
 * creating an immutable, transparent audit trail.
 *
 * Data Model (stored as tx.metadata):
 *   - marketplace:listing   → Service listing (title, price, category, seller)
 *   - marketplace:purchase  → Purchase record (listing + payment link)
 *   - marketplace:review    → Rating + review for a completed purchase
 *   - marketplace:update    → Status update for a listing (active/paused/sold)
 */

export class Marketplace {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    // In-memory index for fast queries (rebuilt from DAG on startup)
    /** @type {Map<string, Listing>} */
    this.listings = new Map();

    /** @type {Map<string, Purchase[]>} */
    this.purchasesByListing = new Map();

    /** @type {Map<string, Review[]>} */
    this.reviewsByListing = new Map();

    // Rebuild index from existing DAG data
    this._rebuildIndex();
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Create a new service listing
   * @returns {{ listingId: string, txId: string }}
   */
  createListing(wallet, tips, { title, description, price, category, tags, deliveryTime }) {
    if (!title || !price || price <= 0) {
      throw new Error('title and price (> 0) are required');
    }

    const listingId = this._generateId();
    const metadata = {
      _mp: 'listing',
      listingId,
      title,
      description: description || '',
      price,
      category: category || 'general',
      tags: tags || [],
      deliveryTime: deliveryTime || 'instant',
      seller: wallet.address,
      status: 'active',
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Update index
    this._indexListing(tx);

    return { listingId, txId: tx.id };
  }

  /**
   * Purchase a service - creates payment transfer + purchase record
   * @returns {{ purchaseId: string, paymentTxId: string, recordTxId: string }}
   */
  purchase(wallet, tips, { listingId, message }) {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error('Listing not found');
    if (listing.status !== 'active') throw new Error('Listing is not active');
    if (listing.seller === wallet.address) throw new Error('Cannot buy your own listing');

    // Check balance
    const balance = this.dag.getBalance(wallet.address);
    if (balance < listing.price) throw new Error(`Insufficient balance. Need ${listing.price}, have ${balance}`);

    // 1. Create payment transfer to seller
    const paymentTx = wallet.send(listing.seller, listing.price, tips, {
      _mp: 'payment',
      listingId,
      purpose: `Purchase: ${listing.title}`,
    });
    const payResult = this.dag.addTransaction(paymentTx);
    if (!payResult.success) throw new Error(payResult.error);

    // 2. Create purchase record (data tx)
    const purchaseId = this._generateId();
    const tips2 = this.dag.selectTips();
    const recordTx = wallet.sendData(tips2, {
      _mp: 'purchase',
      purchaseId,
      listingId,
      paymentTxId: paymentTx.id,
      buyer: wallet.address,
      seller: listing.seller,
      price: listing.price,
      title: listing.title,
      message: message || '',
      status: 'completed',
      purchasedAt: Date.now(),
    });
    const recResult = this.dag.addTransaction(recordTx);
    if (!recResult.success) throw new Error(recResult.error);

    // Update index
    this._indexPurchase(recordTx);

    return { purchaseId, paymentTxId: paymentTx.id, recordTxId: recordTx.id };
  }

  /**
   * Leave a review for a purchase
   * @returns {{ txId: string }}
   */
  review(wallet, tips, { purchaseId, rating, comment }) {
    if (!rating || rating < 1 || rating > 5) throw new Error('Rating must be 1-5');

    // Find the purchase
    let purchase = null;
    for (const purchases of this.purchasesByListing.values()) {
      purchase = purchases.find(p => p.purchaseId === purchaseId);
      if (purchase) break;
    }
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.buyer !== wallet.address) throw new Error('Only the buyer can review');

    // Check if already reviewed
    const existing = this.reviewsByListing.get(purchase.listingId) || [];
    if (existing.some(r => r.buyer === wallet.address && r.purchaseId === purchaseId)) {
      throw new Error('Already reviewed this purchase');
    }

    const tx = wallet.sendData(tips, {
      _mp: 'review',
      purchaseId,
      listingId: purchase.listingId,
      buyer: wallet.address,
      seller: purchase.seller,
      rating,
      comment: comment || '',
      reviewedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexReview(tx);

    return { txId: tx.id };
  }

  /**
   * Update listing status (active, paused, closed)
   */
  updateListing(wallet, tips, { listingId, status, price, title, description }) {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error('Listing not found');
    if (listing.seller !== wallet.address) throw new Error('Only the seller can update');

    const updates = { _mp: 'update', listingId, updatedAt: Date.now() };
    if (status) updates.status = status;
    if (price) updates.price = price;
    if (title) updates.title = title;
    if (description) updates.description = description;

    const tx = wallet.sendData(tips, updates);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Apply updates to index
    if (status) listing.status = status;
    if (price) listing.price = price;
    if (title) listing.title = title;
    if (description) listing.description = description;

    return { txId: tx.id };
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /**
   * Browse listings with filters
   */
  getListings({ category, seller, search, status, sortBy, limit, offset } = {}) {
    let results = [...this.listings.values()];

    // Filters
    if (category) results = results.filter(l => l.category === category);
    if (seller) results = results.filter(l => l.seller === seller);
    if (status) results = results.filter(l => l.status === status);
    else results = results.filter(l => l.status === 'active'); // Default: only active
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(l =>
        l.title.toLowerCase().includes(q) ||
        l.description.toLowerCase().includes(q) ||
        (l.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }

    // Enrich with stats
    results = results.map(l => this._enrichListing(l));

    // Sort
    if (sortBy === 'price_asc') results.sort((a, b) => a.price - b.price);
    else if (sortBy === 'price_desc') results.sort((a, b) => b.price - a.price);
    else if (sortBy === 'rating') results.sort((a, b) => b.avgRating - a.avgRating);
    else if (sortBy === 'sales') results.sort((a, b) => b.totalSales - a.totalSales);
    else results.sort((a, b) => b.createdAt - a.createdAt); // newest first

    const total = results.length;
    const off = offset || 0;
    const lim = limit || 50;
    results = results.slice(off, off + lim);

    return { listings: results, total, offset: off, limit: lim };
  }

  /**
   * Get a single listing with full details
   */
  getListing(listingId) {
    const listing = this.listings.get(listingId);
    if (!listing) return null;

    const enriched = this._enrichListing(listing);
    enriched.reviews = (this.reviewsByListing.get(listingId) || [])
      .sort((a, b) => b.reviewedAt - a.reviewedAt)
      .slice(0, 20);
    enriched.recentPurchases = (this.purchasesByListing.get(listingId) || [])
      .sort((a, b) => b.purchasedAt - a.purchasedAt)
      .slice(0, 10)
      .map(p => ({ buyer: p.buyer.substring(0, 16) + '...', purchasedAt: p.purchasedAt }));

    return enriched;
  }

  /**
   * Get purchases for a specific buyer
   */
  getPurchases(address) {
    const purchases = [];
    for (const list of this.purchasesByListing.values()) {
      for (const p of list) {
        if (p.buyer === address) purchases.push(p);
      }
    }
    return purchases.sort((a, b) => b.purchasedAt - a.purchasedAt);
  }

  /**
   * Get all available categories
   */
  getCategories() {
    const counts = {};
    for (const l of this.listings.values()) {
      if (l.status === 'active') {
        counts[l.category] = (counts[l.category] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get marketplace stats
   */
  getStats() {
    const allListings = [...this.listings.values()];
    const active = allListings.filter(l => l.status === 'active');
    let totalVolume = 0;
    let totalSales = 0;
    for (const purchases of this.purchasesByListing.values()) {
      for (const p of purchases) {
        totalVolume += p.price;
        totalSales++;
      }
    }
    const sellers = new Set(allListings.map(l => l.seller));

    return {
      totalListings: allListings.length,
      activeListings: active.length,
      totalSales,
      totalVolume,
      totalSellers: sellers.size,
      totalReviews: [...this.reviewsByListing.values()].reduce((sum, r) => sum + r.length, 0),
    };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  _rebuildIndex() {
    this.listings.clear();
    this.purchasesByListing.clear();
    this.reviewsByListing.clear();

    // Process all transactions in order
    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._mp)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._mp) {
        case 'listing': this._indexListing(tx); break;
        case 'purchase': this._indexPurchase(tx); break;
        case 'review': this._indexReview(tx); break;
        case 'update': this._indexUpdate(tx); break;
      }
    }

    const stats = this.getStats();
    if (stats.totalListings > 0) {
      console.log(`[Marketplace] Indexed ${stats.totalListings} listings, ${stats.totalSales} sales`);
    }
  }

  _indexListing(tx) {
    const m = tx.metadata;
    this.listings.set(m.listingId, {
      listingId: m.listingId,
      txId: tx.id,
      title: m.title,
      description: m.description,
      price: m.price,
      category: m.category,
      tags: m.tags || [],
      deliveryTime: m.deliveryTime,
      seller: m.seller || tx.from,
      status: m.status || 'active',
      createdAt: m.createdAt || tx.timestamp,
    });
  }

  _indexPurchase(tx) {
    const m = tx.metadata;
    const list = this.purchasesByListing.get(m.listingId) || [];
    list.push({
      purchaseId: m.purchaseId,
      txId: tx.id,
      listingId: m.listingId,
      paymentTxId: m.paymentTxId,
      buyer: m.buyer || tx.from,
      seller: m.seller,
      price: m.price,
      title: m.title,
      message: m.message,
      status: m.status,
      purchasedAt: m.purchasedAt || tx.timestamp,
    });
    this.purchasesByListing.set(m.listingId, list);
  }

  _indexReview(tx) {
    const m = tx.metadata;
    const list = this.reviewsByListing.get(m.listingId) || [];
    list.push({
      txId: tx.id,
      purchaseId: m.purchaseId,
      listingId: m.listingId,
      buyer: m.buyer || tx.from,
      seller: m.seller,
      rating: m.rating,
      comment: m.comment,
      reviewedAt: m.reviewedAt || tx.timestamp,
    });
    this.reviewsByListing.set(m.listingId, list);
  }

  _indexUpdate(tx) {
    const m = tx.metadata;
    const listing = this.listings.get(m.listingId);
    if (!listing) return;
    if (m.status) listing.status = m.status;
    if (m.price) listing.price = m.price;
    if (m.title) listing.title = m.title;
    if (m.description) listing.description = m.description;
  }

  _enrichListing(listing) {
    const purchases = this.purchasesByListing.get(listing.listingId) || [];
    const reviews = this.reviewsByListing.get(listing.listingId) || [];
    const avgRating = reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : 0;

    return {
      ...listing,
      totalSales: purchases.length,
      totalReviews: reviews.length,
      avgRating: Math.round(avgRating * 10) / 10,
    };
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
