/**
 * IOTAI Wallet
 *
 * Manages keypairs, addresses, and transaction creation.
 * Designed to be used by both humans and AI agents.
 *
 * Security features:
 * - HD key derivation (one master seed, many addresses)
 * - Private keys never exported in plaintext
 * - Nonce-based replay attack protection
 * - Address derived from public key hash (not the key itself)
 */

import {
  generateKeyPair,
  deriveKeyPair,
  seedFromPassphrase,
  publicKeyToAddress,
  encodePublicKey,
} from '../core/crypto.js';
import { createTransaction, createDataTransaction } from '../core/transaction.js';

export class Wallet {
  /**
   * Create a new wallet
   * @param {object} [options]
   * @param {string} [options.passphrase] - derive from passphrase (deterministic)
   */
  constructor(options = {}) {
    if (options.passphrase) {
      this.masterSeed = seedFromPassphrase(options.passphrase);
      const pair = deriveKeyPair(this.masterSeed, 0);
      this.publicKey = pair.publicKey;
      this.secretKey = pair.secretKey;
    } else {
      const pair = generateKeyPair();
      this.publicKey = pair.publicKey;
      this.secretKey = pair.secretKey;
      this.masterSeed = null;
    }

    this.address = publicKeyToAddress(this.publicKey);
    this.derivationIndex = 0;
  }

  /**
   * Create a new wallet from a master seed
   * @param {Uint8Array} seed
   * @param {number} [index=0]
   * @returns {Wallet}
   */
  static fromSeed(seed, index = 0) {
    const wallet = new Wallet();
    wallet.masterSeed = seed;
    const pair = deriveKeyPair(seed, index);
    wallet.publicKey = pair.publicKey;
    wallet.secretKey = pair.secretKey;
    wallet.address = publicKeyToAddress(pair.publicKey);
    wallet.derivationIndex = index;
    return wallet;
  }

  /**
   * Derive a new address from the master seed
   * Useful for privacy (use a fresh address per transaction)
   * @returns {{ address: string, index: number }}
   */
  deriveNextAddress() {
    if (!this.masterSeed) {
      throw new Error('Cannot derive addresses without a master seed. Create wallet with passphrase.');
    }
    this.derivationIndex++;
    const pair = deriveKeyPair(this.masterSeed, this.derivationIndex);
    this.publicKey = pair.publicKey;
    this.secretKey = pair.secretKey;
    this.address = publicKeyToAddress(pair.publicKey);
    return { address: this.address, index: this.derivationIndex };
  }

  /**
   * Create a transfer transaction
   * @param {string} to - recipient address
   * @param {number} amount - amount of IOTAI
   * @param {string[]} parents - 2 parent transaction IDs (tips)
   * @param {object} [metadata] - optional data for AI agents
   * @returns {import('../core/transaction.js').Transaction}
   */
  send(to, amount, parents, metadata = null) {
    return createTransaction({
      senderSecretKey: this.secretKey,
      senderPublicKey: this.publicKey,
      to,
      amount,
      parents,
      metadata,
    });
  }

  /**
   * Create a data-only transaction (zero value, carries metadata)
   * Perfect for AI agent communication on the DAG
   * @param {string[]} parents - 2 parent transaction IDs
   * @param {object} metadata - the data to store
   * @returns {import('../core/transaction.js').Transaction}
   */
  sendData(parents, metadata) {
    return createDataTransaction({
      senderSecretKey: this.secretKey,
      senderPublicKey: this.publicKey,
      parents,
      metadata,
    });
  }

  /**
   * Get wallet info (safe to share)
   */
  getInfo() {
    return {
      address: this.address,
      publicKey: encodePublicKey(this.publicKey),
      derivationIndex: this.derivationIndex,
      hasHD: !!this.masterSeed,
    };
  }

  /**
   * Export wallet data for backup (SENSITIVE)
   * @param {string} encryptionKey - key to encrypt the export (future)
   * @returns {object}
   */
  export() {
    return {
      address: this.address,
      publicKey: encodePublicKey(this.publicKey),
      // In production, secretKey would be encrypted before export
      derivationIndex: this.derivationIndex,
    };
  }
}
