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

    /** @type {Map<string, Dispute>} */
    this.disputes = new Map();

    /** @type {Map<string, Dispute[]>} */
    this.disputesByListing = new Map();

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
   * Purchase a service with escrow protection
   * Funds go to escrow address, released when buyer confirms or auto-released after timeout
   * @returns {{ purchaseId: string, paymentTxId: string, recordTxId: string, escrow: boolean }}
   */
  purchase(wallet, tips, { listingId, message, useEscrow = true }) {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error('Listing not found');
    if (listing.status !== 'active') throw new Error('Listing is not active');
    if (listing.seller === wallet.address) throw new Error('Cannot buy your own listing');

    // Check balance (price + fee)
    const balance = this.dag.getBalance(wallet.address);
    if (balance < listing.price) throw new Error(`Insufficient balance. Need ${listing.price}, have ${balance}`);

    const purchaseId = this._generateId();
    const escrowAddr = useEscrow ? `iotai_escrow_${purchaseId}` : null;
    const payTo = useEscrow ? escrowAddr : listing.seller;

    // 1. Create payment transfer (to escrow or direct to seller)
    const paymentTx = wallet.send(payTo, listing.price, tips, {
      _mp: 'payment',
      listingId,
      purchaseId,
      escrow: useEscrow,
      purpose: `Purchase: ${listing.title}`,
    });
    const payResult = this.dag.addTransaction(paymentTx);
    if (!payResult.success) throw new Error(payResult.error);

    // 2. Create purchase record (data tx)
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
      status: useEscrow ? 'in_escrow' : 'completed',
      escrowAddress: escrowAddr,
      escrowDeadline: useEscrow ? Date.now() + (24 * 60 * 60 * 1000) : null, // 24h auto-release
      purchasedAt: Date.now(),
    });
    const recResult = this.dag.addTransaction(recordTx);
    if (!recResult.success) throw new Error(recResult.error);

    // Update index
    this._indexPurchase(recordTx);

    return { purchaseId, paymentTxId: paymentTx.id, recordTxId: recordTx.id, escrow: useEscrow };
  }

  // ============================================================
  // ESCROW
  // ============================================================

  /**
   * Buyer confirms delivery — releases escrow funds to seller
   */
  confirmDelivery(wallet, tips, { purchaseId }) {
    const purchase = this._findPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.buyer !== wallet.address) throw new Error('Only buyer can confirm');
    if (purchase.status !== 'in_escrow') throw new Error('Purchase not in escrow');

    // Transfer from escrow to seller
    const escrowBalance = this.dag.getBalance(purchase.escrowAddress);
    if (escrowBalance < purchase.price) throw new Error('Escrow funds missing');

    // Record the release on DAG
    const tx = wallet.sendData(tips, {
      _mp: 'escrow_release',
      purchaseId,
      listingId: purchase.listingId,
      seller: purchase.seller,
      amount: purchase.price,
      releasedAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Move funds: escrow -> seller
    this.dag.balances.set(purchase.escrowAddress, 0);
    const sellerBal = this.dag.balances.get(purchase.seller) || 0;
    this.dag.balances.set(purchase.seller, sellerBal + purchase.price);

    purchase.status = 'completed';
    purchase.completedAt = Date.now();

    return { txId: tx.id, released: purchase.price };
  }

  /**
   * Buyer requests refund from escrow (before delivery confirmed)
   */
  requestRefund(wallet, tips, { purchaseId, reason }) {
    const purchase = this._findPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.buyer !== wallet.address) throw new Error('Only buyer can request refund');
    if (purchase.status !== 'in_escrow') throw new Error('Purchase not in escrow');

    const tx = wallet.sendData(tips, {
      _mp: 'escrow_refund_request',
      purchaseId,
      listingId: purchase.listingId,
      reason: reason || 'Service not delivered',
      requestedAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    purchase.status = 'refund_requested';
    purchase.refundReason = reason;

    return { txId: tx.id };
  }

  /**
   * Seller approves refund — returns escrow funds to buyer
   */
  approveRefund(wallet, tips, { purchaseId }) {
    const purchase = this._findPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.seller !== wallet.address) throw new Error('Only seller can approve refund');
    if (purchase.status !== 'refund_requested') throw new Error('No refund requested');

    const tx = wallet.sendData(tips, {
      _mp: 'escrow_refund',
      purchaseId,
      listingId: purchase.listingId,
      buyer: purchase.buyer,
      amount: purchase.price,
      refundedAt: Date.now(),
    });
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Move funds: escrow -> buyer
    this.dag.balances.set(purchase.escrowAddress, 0);
    const buyerBal = this.dag.balances.get(purchase.buyer) || 0;
    this.dag.balances.set(purchase.buyer, buyerBal + purchase.price);

    purchase.status = 'refunded';
    purchase.refundedAt = Date.now();

    return { txId: tx.id, refunded: purchase.price };
  }

  /**
   * Auto-release expired escrows (called periodically)
   * Releases funds to seller if buyer hasn't acted within deadline
   */
  processExpiredEscrows() {
    const now = Date.now();
    let released = 0;

    for (const purchases of this.purchasesByListing.values()) {
      for (const p of purchases) {
        if (p.status === 'in_escrow' && p.escrowDeadline && now > p.escrowDeadline) {
          const escrowBal = this.dag.getBalance(p.escrowAddress);
          if (escrowBal >= p.price) {
            this.dag.balances.set(p.escrowAddress, 0);
            const sellerBal = this.dag.balances.get(p.seller) || 0;
            this.dag.balances.set(p.seller, sellerBal + p.price);
            p.status = 'completed';
            p.completedAt = now;
            p.autoReleased = true;
            released++;
          }
        }
      }
    }
    return { released };
  }

  /**
   * Get escrow status for a purchase
   */
  getEscrowStatus(purchaseId) {
    const purchase = this._findPurchase(purchaseId);
    if (!purchase) return null;
    return {
      purchaseId,
      status: purchase.status,
      escrowAddress: purchase.escrowAddress,
      escrowBalance: purchase.escrowAddress ? this.dag.getBalance(purchase.escrowAddress) : 0,
      price: purchase.price,
      buyer: purchase.buyer,
      seller: purchase.seller,
      deadline: purchase.escrowDeadline,
      isExpired: purchase.escrowDeadline ? Date.now() > purchase.escrowDeadline : false,
    };
  }

  /** Helper to find a purchase across all listings */
  _findPurchase(purchaseId) {
    for (const purchases of this.purchasesByListing.values()) {
      const p = purchases.find(p => p.purchaseId === purchaseId);
      if (p) return p;
    }
    return null;
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

  // ============================================================
  // DISPUTES
  // ============================================================

  /**
   * Open a dispute for a purchase
   */
  openDispute(wallet, tips, { purchaseId, reason, evidence }) {
    if (!reason) throw new Error('Reason is required');

    // Find the purchase
    let purchase = null;
    for (const purchases of this.purchasesByListing.values()) {
      purchase = purchases.find(p => p.purchaseId === purchaseId);
      if (purchase) break;
    }
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.buyer !== wallet.address) throw new Error('Only the buyer can open a dispute');

    // Check no existing open dispute
    const existing = this.disputes.get(purchaseId);
    if (existing && existing.status !== 'resolved') throw new Error('Dispute already open for this purchase');

    const disputeId = this._generateId();
    const tx = wallet.sendData(tips, {
      _mp: 'dispute',
      disputeId,
      purchaseId,
      listingId: purchase.listingId,
      buyer: wallet.address,
      seller: purchase.seller,
      reason,
      evidence: evidence || '',
      status: 'open',
      openedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexDispute(tx);
    return { disputeId, txId: tx.id };
  }

  /**
   * Seller responds to a dispute
   */
  respondDispute(wallet, tips, { disputeId, response }) {
    if (!response) throw new Error('Response is required');

    const dispute = [...this.disputes.values()].find(d => d.disputeId === disputeId);
    if (!dispute) throw new Error('Dispute not found');
    if (dispute.seller !== wallet.address) throw new Error('Only the seller can respond');
    if (dispute.status !== 'open') throw new Error('Dispute is not open');

    const tx = wallet.sendData(tips, {
      _mp: 'dispute_response',
      disputeId,
      seller: wallet.address,
      response,
      respondedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    dispute.sellerResponse = response;
    dispute.status = 'responded';
    dispute.respondedAt = Date.now();

    return { txId: tx.id };
  }

  /**
   * Resolve a dispute (buyer accepts resolution or auto-resolve)
   */
  resolveDispute(wallet, tips, { disputeId, resolution, refund }) {
    const dispute = [...this.disputes.values()].find(d => d.disputeId === disputeId);
    if (!dispute) throw new Error('Dispute not found');
    if (dispute.buyer !== wallet.address && dispute.seller !== wallet.address) {
      throw new Error('Only buyer or seller can resolve');
    }
    if (dispute.status === 'resolved') throw new Error('Already resolved');

    const tx = wallet.sendData(tips, {
      _mp: 'dispute_resolve',
      disputeId,
      resolvedBy: wallet.address,
      resolution: resolution || 'mutual_agreement',
      refund: refund || false,
      resolvedAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    dispute.status = 'resolved';
    dispute.resolution = resolution || 'mutual_agreement';
    dispute.resolvedAt = Date.now();

    return { txId: tx.id };
  }

  /**
   * Get disputes for a user (as buyer or seller)
   */
  getDisputes(address) {
    const result = [];
    for (const dispute of this.disputes.values()) {
      if (dispute.buyer === address || dispute.seller === address) {
        result.push(dispute);
      }
    }
    return result.sort((a, b) => b.openedAt - a.openedAt);
  }

  // ============================================================
  // SELLER PROFILES
  // ============================================================

  /**
   * Get seller profile with reputation stats
   */
  getSellerProfile(address) {
    const sellerListings = [...this.listings.values()].filter(l => l.seller === address);
    if (sellerListings.length === 0) return null;

    let totalSales = 0;
    let totalVolume = 0;
    let totalRatings = 0;
    let ratingSum = 0;
    let disputes = 0;
    let resolvedDisputes = 0;

    for (const listing of sellerListings) {
      const purchases = this.purchasesByListing.get(listing.listingId) || [];
      totalSales += purchases.length;
      totalVolume += purchases.reduce((s, p) => s + p.price, 0);

      const reviews = this.reviewsByListing.get(listing.listingId) || [];
      totalRatings += reviews.length;
      ratingSum += reviews.reduce((s, r) => s + r.rating, 0);

      const listingDisputes = this.disputesByListing.get(listing.listingId) || [];
      disputes += listingDisputes.length;
      resolvedDisputes += listingDisputes.filter(d => d.status === 'resolved').length;
    }

    const avgRating = totalRatings > 0 ? Math.round((ratingSum / totalRatings) * 10) / 10 : 0;
    const activeListings = sellerListings.filter(l => l.status === 'active');
    const firstListing = sellerListings.sort((a, b) => a.createdAt - b.createdAt)[0];

    // Reputation score: 0-100
    let reputation = 50; // base
    reputation += Math.min(avgRating * 8, 40); // up to 40 for ratings
    reputation += Math.min(totalSales * 2, 20); // up to 20 for sales
    reputation -= disputes * 5; // -5 per dispute
    reputation += resolvedDisputes * 2; // +2 per resolved dispute
    reputation = Math.max(0, Math.min(100, Math.round(reputation)));

    // Level based on reputation
    let level = 'New Seller';
    if (reputation >= 90) level = 'Top Seller';
    else if (reputation >= 75) level = 'Trusted';
    else if (reputation >= 60) level = 'Established';
    else if (reputation >= 40) level = 'Active';

    return {
      address,
      level,
      reputation,
      avgRating,
      totalSales,
      totalVolume,
      totalListings: sellerListings.length,
      activeListings: activeListings.length,
      totalReviews: totalRatings,
      disputes,
      resolvedDisputes,
      memberSince: firstListing?.createdAt || Date.now(),
      listings: activeListings.map(l => this._enrichListing(l)),
    };
  }

  /**
   * Get top sellers
   */
  getTopSellers(limit = 10) {
    const sellers = new Set();
    for (const l of this.listings.values()) sellers.add(l.seller);

    const profiles = [];
    for (const addr of sellers) {
      const profile = this.getSellerProfile(addr);
      if (profile) profiles.push(profile);
    }

    return profiles
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, limit);
  }

  // ============================================================
  // FEATURED / SEED DATA
  // ============================================================

  /**
   * Get featured listings (top rated with sales)
   */
  getFeatured(limit = 6) {
    let results = [...this.listings.values()].filter(l => l.status === 'active');
    results = results.map(l => this._enrichListing(l));
    // Score = (avgRating * 2) + totalSales + (totalReviews * 0.5)
    results.sort((a, b) => {
      const scoreA = (a.avgRating * 2) + a.totalSales + (a.totalReviews * 0.5);
      const scoreB = (b.avgRating * 2) + b.totalSales + (b.totalReviews * 0.5);
      return scoreB - scoreA;
    });
    return results.slice(0, limit);
  }

  /**
   * Seed demo listings (called once if marketplace is empty)
   */
  seedDemoData(wallet, tips) {
    if (this.listings.size > 0) return; // Already has data

    const demoListings = [
      { title: 'GPT-4 Translation Service', description: 'Professional AI-powered translation between 50+ languages. Fast, accurate, context-aware translations for documents, APIs, and real-time chat. Supports technical, legal, and medical terminology.', price: 50, category: 'translation', tags: ['gpt4', 'multilingual', 'fast', 'api'], deliveryTime: 'instant' },
      { title: 'AI Image Generation (DALL-E 3)', description: 'Generate stunning, high-resolution images from text descriptions. Perfect for marketing materials, concept art, product mockups, and creative projects. Batch processing available.', price: 100, category: 'image-generation', tags: ['dalle3', 'creative', 'high-res', 'batch'], deliveryTime: '< 1 min' },
      { title: 'Smart Contract Audit Agent', description: 'Automated security audit for Solidity smart contracts. Detects reentrancy, overflow, access control, and 50+ vulnerability patterns. Generates detailed PDF report with fix recommendations.', price: 500, category: 'analysis', tags: ['security', 'solidity', 'audit', 'defi'], deliveryTime: '< 5 min' },
      { title: 'Sentiment Analysis Pipeline', description: 'Real-time sentiment analysis for social media, reviews, and news. Supports 12 languages with emotion detection, aspect-based sentiment, and trend analysis. REST API included.', price: 75, category: 'data-processing', tags: ['nlp', 'sentiment', 'realtime', 'api'], deliveryTime: 'instant' },
      { title: 'Code Generation Agent (Full Stack)', description: 'AI agent that generates production-ready code from natural language specifications. Supports React, Node.js, Python, Go, and Rust. Includes tests, documentation, and CI/CD configs.', price: 200, category: 'code-generation', tags: ['fullstack', 'react', 'nodejs', 'python'], deliveryTime: '< 5 min' },
      { title: 'GPU Compute - A100 (1hr)', description: 'Dedicated NVIDIA A100 GPU compute for ML training, inference, or rendering. Pre-installed with PyTorch, TensorFlow, and CUDA. SSH access and Jupyter notebook included.', price: 300, category: 'compute', tags: ['gpu', 'a100', 'ml', 'training'], deliveryTime: 'instant' },
      { title: 'Autonomous Web Scraper', description: 'Intelligent web scraping agent that navigates complex sites, handles CAPTCHAs, pagination, and dynamic content. Outputs structured JSON/CSV. Respects robots.txt and rate limits.', price: 80, category: 'automation', tags: ['scraping', 'data', 'json', 'automation'], deliveryTime: '< 1 min' },
      { title: 'Decentralized Storage (100GB)', description: 'Encrypted, redundant file storage across distributed nodes. IPFS-compatible with CDN edge caching. 99.9% uptime SLA. REST API for upload/download/manage.', price: 150, category: 'storage', tags: ['ipfs', 'encrypted', 'cdn', 'backup'], deliveryTime: 'instant' },
      { title: 'AI Research Assistant', description: 'Agent that searches academic papers, summarizes findings, generates literature reviews, and identifies research gaps. Covers arXiv, PubMed, IEEE, and Google Scholar.', price: 120, category: 'ai-models', tags: ['research', 'papers', 'summarization', 'academic'], deliveryTime: '< 5 min' },
      { title: 'Voice Cloning & TTS Service', description: 'Clone any voice from a 30-second sample. Generate natural speech in 20+ languages. Perfect for podcasts, audiobooks, virtual assistants, and accessibility tools.', price: 250, category: 'ai-models', tags: ['voice', 'tts', 'cloning', 'multilingual'], deliveryTime: '< 1 min' },
      { title: 'Automated API Testing Suite', description: 'AI-powered API testing that generates test cases from OpenAPI specs. Includes load testing, fuzzing, and regression detection. Integrates with GitHub Actions and Jenkins.', price: 90, category: 'automation', tags: ['testing', 'api', 'ci-cd', 'quality'], deliveryTime: '< 1 min' },
      { title: 'Financial Data Analysis Agent', description: 'Real-time market data analysis with predictive modeling. Covers stocks, crypto, forex. Technical indicators, pattern recognition, and risk assessment reports.', price: 350, category: 'analysis', tags: ['finance', 'crypto', 'stocks', 'prediction'], deliveryTime: '< 5 min' },
    ];

    console.log('[Marketplace] Seeding demo listings...');
    for (const listing of demoListings) {
      try {
        const freshTips = this.dag.selectTips();
        this.createListing(wallet, freshTips, listing);
      } catch (e) {
        console.log(`[Marketplace] Seed error: ${e.message}`);
      }
    }
    console.log(`[Marketplace] Seeded ${this.listings.size} demo listings`);
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
    this.disputes.clear();
    this.disputesByListing.clear();

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
        case 'dispute': this._indexDispute(tx); break;
        case 'dispute_response': this._indexDisputeResponse(tx); break;
        case 'dispute_resolve': this._indexDisputeResolve(tx); break;
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
      escrowAddress: m.escrowAddress || null,
      escrowDeadline: m.escrowDeadline || null,
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

  _indexDispute(tx) {
    const m = tx.metadata;
    const dispute = {
      disputeId: m.disputeId,
      purchaseId: m.purchaseId,
      listingId: m.listingId,
      buyer: m.buyer || tx.from,
      seller: m.seller,
      reason: m.reason,
      evidence: m.evidence,
      status: m.status || 'open',
      openedAt: m.openedAt || tx.timestamp,
    };
    this.disputes.set(m.purchaseId, dispute);
    const list = this.disputesByListing.get(m.listingId) || [];
    list.push(dispute);
    this.disputesByListing.set(m.listingId, list);
  }

  _indexDisputeResponse(tx) {
    const m = tx.metadata;
    const dispute = [...this.disputes.values()].find(d => d.disputeId === m.disputeId);
    if (dispute) {
      dispute.sellerResponse = m.response;
      dispute.status = 'responded';
      dispute.respondedAt = m.respondedAt || tx.timestamp;
    }
  }

  _indexDisputeResolve(tx) {
    const m = tx.metadata;
    const dispute = [...this.disputes.values()].find(d => d.disputeId === m.disputeId);
    if (dispute) {
      dispute.status = 'resolved';
      dispute.resolution = m.resolution;
      dispute.resolvedAt = m.resolvedAt || tx.timestamp;
    }
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
