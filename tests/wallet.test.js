import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet/wallet.js';
import { verifyTransaction } from '../src/core/transaction.js';

describe('Wallet creation', () => {
  it('creates a random wallet', () => {
    const w = new Wallet();
    assert.match(w.address, /^iotai_/);
    assert.ok(w.publicKey);
    assert.ok(w.secretKey);
    assert.equal(w.mnemonic, null);
    assert.equal(w.masterSeed, null);
  });

  it('creates wallet with seed phrase', () => {
    const w = Wallet.createWithSeedPhrase();
    assert.match(w.address, /^iotai_/);
    assert.ok(w.mnemonic);
    assert.equal(w.mnemonic.split(' ').length, 12);
    assert.ok(w.masterSeed);
  });

  it('creates wallet from passphrase (deterministic)', () => {
    const w1 = new Wallet({ passphrase: 'my-secret' });
    const w2 = new Wallet({ passphrase: 'my-secret' });
    assert.equal(w1.address, w2.address);
  });

  it('different passphrases produce different wallets', () => {
    const w1 = new Wallet({ passphrase: 'alpha' });
    const w2 = new Wallet({ passphrase: 'beta' });
    assert.notEqual(w1.address, w2.address);
  });
});

describe('Wallet.fromMnemonic', () => {
  it('restores wallet from seed phrase', () => {
    const original = Wallet.createWithSeedPhrase();
    const restored = Wallet.fromMnemonic(original.mnemonic);
    assert.equal(restored.address, original.address);
  });

  it('throws on invalid mnemonic', () => {
    assert.throws(() => {
      Wallet.fromMnemonic('not a valid mnemonic phrase at all here');
    });
  });
});

describe('Wallet.deriveNextAddress', () => {
  it('derives new addresses from HD wallet', () => {
    const w = new Wallet({ passphrase: 'hd-test' });
    const addr0 = w.address;
    const { address: addr1, index } = w.deriveNextAddress();
    assert.notEqual(addr0, addr1);
    assert.equal(index, 1);
  });

  it('throws if no master seed', () => {
    const w = new Wallet(); // random, no seed
    assert.throws(() => w.deriveNextAddress(), /master seed/);
  });
});

describe('Wallet.send', () => {
  it('creates a valid signed transfer', () => {
    const w = new Wallet();
    const parents = ['a'.repeat(64), 'b'.repeat(64)];
    const tx = w.send('iotai_recipient', 100, parents);
    assert.equal(tx.type, 'transfer');
    assert.equal(tx.from, w.address);
    assert.equal(tx.amount, 100);
    assert.ok(verifyTransaction(tx).valid);
  });

  it('includes metadata when provided', () => {
    const w = new Wallet();
    const parents = ['a'.repeat(64), 'b'.repeat(64)];
    const tx = w.send('iotai_recipient', 50, parents, { reason: 'test' });
    assert.deepEqual(tx.metadata, { reason: 'test' });
  });
});

describe('Wallet.sendData', () => {
  it('creates a valid data transaction', () => {
    const w = new Wallet();
    const parents = ['a'.repeat(64), 'b'.repeat(64)];
    const tx = w.sendData(parents, { key: 'value' });
    assert.equal(tx.type, 'data');
    assert.equal(tx.amount, 0);
    assert.deepEqual(tx.metadata, { key: 'value' });
    assert.ok(verifyTransaction(tx).valid);
  });
});

describe('Wallet.getInfo', () => {
  it('returns safe wallet info', () => {
    const w = new Wallet({ passphrase: 'info-test' });
    const info = w.getInfo();
    assert.match(info.address, /^iotai_/);
    assert.ok(info.publicKey);
    assert.equal(info.hasHD, true);
    assert.equal(info.derivationIndex, 0);
  });
});

describe('Wallet.export', () => {
  it('does not expose secret key', () => {
    const w = new Wallet();
    const exported = w.export();
    assert.ok(exported.address);
    assert.ok(exported.publicKey);
    assert.ok(!exported.secretKey);
  });
});
