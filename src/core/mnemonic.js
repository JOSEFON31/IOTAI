/**
 * IOTAI Mnemonic Seed Phrase Module
 *
 * BIP39-compatible seed phrase generation and restoration.
 * 12-word phrases with 128 bits of entropy.
 */

import * as bip39 from 'bip39';
import { createHash } from 'blake3';
import { fromString } from 'uint8arrays';

/**
 * Generate a new 12-word mnemonic seed phrase
 * @returns {string} 12 space-separated words
 */
export function generateMnemonic() {
  return bip39.generateMnemonic(128); // 128 bits = 12 words
}

/**
 * Convert a mnemonic phrase to a 32-byte seed for key derivation
 * Uses BLAKE3 for fast, secure hashing (instead of PBKDF2)
 * @param {string} mnemonic - 12-word seed phrase
 * @returns {Uint8Array} 32-byte seed
 */
export function mnemonicToSeed(mnemonic) {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash().update(fromString('iotai-seed:' + normalized)).digest();
}

/**
 * Validate a mnemonic phrase
 * @param {string} mnemonic
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMnemonic(mnemonic) {
  if (!mnemonic || typeof mnemonic !== 'string') {
    return { valid: false, error: 'Mnemonic is required' };
  }

  const words = mnemonic.trim().toLowerCase().split(/\s+/);

  if (words.length !== 12) {
    return { valid: false, error: `Expected 12 words, got ${words.length}` };
  }

  if (!bip39.validateMnemonic(mnemonic.trim().toLowerCase())) {
    return { valid: false, error: 'Invalid mnemonic: one or more words are not in the BIP39 wordlist' };
  }

  return { valid: true };
}
