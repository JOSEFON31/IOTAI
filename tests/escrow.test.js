import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { Marketplace } from '../src/marketplace/marketplace.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const seller = new Wallet({ passphrase: 'escrow-seller-test' });
  const buyer = new Wallet({ passphrase: 'escrow-buyer-test' });
  dag.balances.set(seller.address, 50_000);
  dag.balances.set(buyer.address, 50_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 100_000);
  const marketplace = new Marketplace({ dag });
  return { dag, seller, buyer, marketplace };
}

describe('Escrow - Purchase with Escrow', () => {
  it('funds go to escrow address, not seller', () => {
    const { dag, seller, buyer, marketplace } = setup();

    // Create listing
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Test Service', price: 1000, category: 'test',
    });

    const sellerBalBefore = dag.getBalance(seller.address);

    // Purchase with escrow
    const { purchaseId, escrow } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    assert.equal(escrow, true);
    // Seller should NOT have received funds yet
    assert.equal(dag.getBalance(seller.address), sellerBalBefore);
    // Escrow address should hold the funds
    const escrowBal = dag.getBalance(`iotai_escrow_${purchaseId}`);
    assert.equal(escrowBal, 1000);
  });

  it('direct purchase (no escrow) pays seller immediately', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Direct Service', price: 500, category: 'test',
    });

    const sellerBalBefore = dag.getBalance(seller.address);
    marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: false,
    });

    assert.equal(dag.getBalance(seller.address), sellerBalBefore + 500);
  });
});

describe('Escrow - Confirm Delivery', () => {
  it('releases funds to seller on confirmation', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Escrow Service', price: 2000, category: 'test',
    });

    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    const sellerBalBefore = dag.getBalance(seller.address);
    const result = marketplace.confirmDelivery(buyer, dag.selectTips(), { purchaseId });

    assert.equal(result.released, 2000);
    assert.equal(dag.getBalance(seller.address), sellerBalBefore + 2000);
    assert.equal(dag.getBalance(`iotai_escrow_${purchaseId}`), 0);
  });

  it('only buyer can confirm', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Auth Test', price: 100, category: 'test',
    });
    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    assert.throws(() => {
      marketplace.confirmDelivery(seller, dag.selectTips(), { purchaseId });
    }, /Only buyer/);
  });
});

describe('Escrow - Refund Flow', () => {
  it('buyer requests refund, seller approves, buyer gets funds back', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Refund Test', price: 3000, category: 'test',
    });

    const buyerBalBefore = dag.getBalance(buyer.address);

    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    // Buyer requests refund
    marketplace.requestRefund(buyer, dag.selectTips(), {
      purchaseId, reason: 'Not as described',
    });

    // Seller approves refund
    const result = marketplace.approveRefund(seller, dag.selectTips(), { purchaseId });
    assert.equal(result.refunded, 3000);
    assert.equal(dag.getBalance(`iotai_escrow_${purchaseId}`), 0);
  });

  it('only buyer can request refund', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Auth', price: 100, category: 'test',
    });
    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    assert.throws(() => {
      marketplace.requestRefund(seller, dag.selectTips(), { purchaseId });
    }, /Only buyer/);
  });

  it('only seller can approve refund', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Auth2', price: 100, category: 'test',
    });
    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });
    marketplace.requestRefund(buyer, dag.selectTips(), { purchaseId });

    assert.throws(() => {
      marketplace.approveRefund(buyer, dag.selectTips(), { purchaseId });
    }, /Only seller/);
  });
});

describe('Escrow - Auto-Release', () => {
  it('processExpiredEscrows releases funds after deadline', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Expire Test', price: 500, category: 'test',
    });

    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    // Manually set deadline to past
    const purchase = marketplace._findPurchase(purchaseId);
    purchase.escrowDeadline = Date.now() - 1000;

    const sellerBalBefore = dag.getBalance(seller.address);
    const result = marketplace.processExpiredEscrows();
    assert.equal(result.released, 1);
    assert.equal(dag.getBalance(seller.address), sellerBalBefore + 500);
    assert.equal(purchase.status, 'completed');
    assert.equal(purchase.autoReleased, true);
  });

  it('does not release non-expired escrows', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Not Expired', price: 500, category: 'test',
    });

    marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    const result = marketplace.processExpiredEscrows();
    assert.equal(result.released, 0);
  });
});

describe('Escrow - Status', () => {
  it('getEscrowStatus returns correct info', () => {
    const { dag, seller, buyer, marketplace } = setup();
    const { listingId } = marketplace.createListing(seller, dag.selectTips(), {
      title: 'Status Test', price: 750, category: 'test',
    });
    const { purchaseId } = marketplace.purchase(buyer, dag.selectTips(), {
      listingId, useEscrow: true,
    });

    const status = marketplace.getEscrowStatus(purchaseId);
    assert.equal(status.purchaseId, purchaseId);
    assert.equal(status.status, 'in_escrow');
    assert.equal(status.price, 750);
    assert.equal(status.escrowBalance, 750);
    assert.equal(status.buyer, buyer.address);
    assert.equal(status.seller, seller.address);
    assert.equal(status.isExpired, false);
  });

  it('returns null for unknown purchase', () => {
    const { marketplace } = setup();
    assert.equal(marketplace.getEscrowStatus('nonexistent'), null);
  });
});
