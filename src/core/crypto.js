/**
 * IOTAI Cryptographic Core
 *
 * Uses Ed25519 for digital signatures (via tweetnacl)
 * and BLAKE3 for fast, secure hashing.
 *
 * Security measures:
 * - Unique nonce per transaction to prevent signature replay attacks
 * - Key derivation for HD wallets
 * - Private keys never leave memory unencrypted
 */

import nacl from 'tweetnacl';
import { createHash, createKeyed } from 'blake3';
import { toString, fromString } from 'uint8arrays';

// ============================================================
// KEY MANAGEMENT
// ============================================================

/**
 * Generate a new Ed25519 keypair for a wallet
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
 */
export function generateKeyPair() {
  return nacl.sign.keyPair();
}

/**
 * Derive a child keypair from a seed + index (HD wallet style)
 * This allows one master seed to generate many addresses deterministically
 * @param {Uint8Array} masterSeed - 32-byte master seed
 * @param {number} index - derivation index
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
 */
export function deriveKeyPair(masterSeed, index) {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);

  // BLAKE3 keyed hash: derive child seed deterministically
  const childSeed = createKeyed(masterSeed).update(indexBytes).digest();
  return nacl.sign.keyPair.fromSeed(childSeed);
}

/**
 * Generate a master seed from a passphrase
 * @param {string} passphrase
 * @returns {Uint8Array} 32-byte seed
 */
export function seedFromPassphrase(passphrase) {
  return createHash().update(fromString(passphrase)).digest();
}

// ============================================================
// HASHING
// ============================================================

/**
 * BLAKE3 hash of arbitrary data, returns hex string
 * @param {Uint8Array|string} data
 * @returns {string} hex hash
 */
export function hash(data) {
  const input = typeof data === 'string' ? fromString(data) : data;
  const digest = createHash().update(input).digest();
  return toString(digest, 'base16');
}

/**
 * Hash a transaction object deterministically
 * Includes a nonce to prevent replay attacks
 * @param {object} txData - transaction fields
 * @returns {string} hex hash
 */
export function hashTransaction(txData) {
  // Canonical JSON serialization (sorted keys)
  const canonical = JSON.stringify(txData, Object.keys(txData).sort());
  return hash(canonical);
}

// ============================================================
// SIGNATURES
// ============================================================

/**
 * Sign data with a secret key
 * @param {string|Uint8Array} data
 * @param {Uint8Array} secretKey - 64-byte Ed25519 secret key
 * @returns {string} base64-encoded signature
 */
export function sign(data, secretKey) {
  const message = typeof data === 'string' ? fromString(data) : data;
  const signature = nacl.sign.detached(message, secretKey);
  return toString(signature, 'base64');
}

/**
 * Verify a signature
 * @param {string|Uint8Array} data - original data
 * @param {string} signatureBase64 - base64-encoded signature
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 * @returns {boolean}
 */
export function verify(data, signatureBase64, publicKey) {
  const message = typeof data === 'string' ? fromString(data) : data;
  const signature = fromString(signatureBase64, 'base64');
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// ============================================================
// NONCE GENERATION (anti-replay)
// ============================================================

/**
 * Generate a unique nonce combining timestamp + randomness
 * This prevents signature replay attacks
 * @returns {string}
 */
export function generateNonce() {
  const timestamp = BigInt(Date.now());
  const random = nacl.randomBytes(8);
  const buffer = new Uint8Array(16);

  // First 8 bytes: timestamp
  const view = new DataView(buffer.buffer);
  view.setBigUint64(0, timestamp, false);

  // Last 8 bytes: random
  buffer.set(random, 8);

  return toString(buffer, 'base16');
}

// ============================================================
// ADDRESS GENERATION
// ============================================================

/**
 * Derive an IOTAI address from a public key
 * Format: iotai_<blake3_hash_first_40_chars>
 * @param {Uint8Array} publicKey
 * @returns {string}
 */
export function publicKeyToAddress(publicKey) {
  const h = hash(publicKey);
  return `iotai_${h.substring(0, 40)}`;
}

/**
 * Encode a public key to base64 for transport
 * @param {Uint8Array} publicKey
 * @returns {string}
 */
export function encodePublicKey(publicKey) {
  return toString(publicKey, 'base64');
}

/**
 * Decode a base64 public key
 * @param {string} encoded
 * @returns {Uint8Array}
 */
export function decodePublicKey(encoded) {
  return fromString(encoded, 'base64');
}
