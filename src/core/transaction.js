/**
 * IOTAI Transaction
 *
 * Each transaction is a vertex in the DAG (Tangle).
 * Every new transaction must reference and validate exactly 2 previous
 * transactions (tips), creating the mesh structure.
 *
 * Transaction lifecycle:
 * 1. Created by sender with value, recipient, and 2 parent references
 * 2. Signed with sender's private key (includes nonce for replay protection)
 * 3. Broadcast to the P2P network
 * 4. Validated by the next transactions that reference it
 */

import {
  hashTransaction,
  sign,
  verify,
  generateNonce,
  publicKeyToAddress,
  encodePublicKey,
  decodePublicKey,
} from './crypto.js';

/**
 * @typedef {Object} Transaction
 * @property {string} id - BLAKE3 hash of the transaction
 * @property {string} from - sender address (iotai_...)
 * @property {string} to - recipient address (iotai_...)
 * @property {number} amount - amount of IOTAI to transfer
 * @property {number} timestamp - Unix timestamp in ms
 * @property {string} nonce - unique nonce (anti-replay)
 * @property {string[]} parents - exactly 2 parent transaction IDs
 * @property {string} senderPublicKey - base64-encoded public key
 * @property {string} signature - base64-encoded Ed25519 signature
 * @property {number} weight - own weight (always 1 for normal tx)
 * @property {number} cumulativeWeight - accumulated from children (computed)
 * @property {string} type - "transfer" | "genesis" | "data"
 * @property {object} [metadata] - optional payload (for AI agents)
 */

// Genesis transaction ID (the root of the DAG)
export const GENESIS_ID = '0'.repeat(64);

/**
 * Create the genesis transaction (origin of the network)
 * @param {number} initialSupply - total IOTAI supply
 * @returns {Transaction}
 */
export function createGenesis(initialSupply) {
  const tx = {
    type: 'genesis',
    from: 'iotai_genesis',
    to: 'iotai_genesis',
    amount: initialSupply,
    timestamp: Date.now(),
    nonce: generateNonce(),
    parents: [],
    senderPublicKey: '',
    signature: '',
    weight: 1,
    cumulativeWeight: 1,
    metadata: { message: 'IOTAI Genesis - AI-powered distributed ledger' },
  };

  tx.id = hashTransaction({
    type: tx.type,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    timestamp: tx.timestamp,
    nonce: tx.nonce,
    parents: tx.parents,
  });

  return tx;
}

/**
 * Create a new transfer transaction
 * @param {object} params
 * @param {Uint8Array} params.senderSecretKey - sender's Ed25519 secret key
 * @param {Uint8Array} params.senderPublicKey - sender's Ed25519 public key
 * @param {string} params.to - recipient address
 * @param {number} params.amount - amount to send
 * @param {string[]} params.parents - exactly 2 parent tx IDs
 * @param {object} [params.metadata] - optional data payload for AI agents
 * @returns {Transaction}
 */
/** Default fee rate: 1% of transfer amount (min 1 IOTAI) */
export const DEFAULT_FEE_RATE = 0.01;
export const MIN_FEE = 1;
export const FEE_POOL_ADDRESS = 'iotai_fee_pool';

/**
 * Calculate the fee for a given amount
 * @param {number} amount
 * @param {number} [feeRate] - override fee rate (0-1)
 * @returns {number}
 */
export function calculateFee(amount, feeRate = DEFAULT_FEE_RATE) {
  if (amount <= 0) return 0;
  return Math.max(MIN_FEE, Math.round(amount * feeRate));
}

export function createTransaction({
  senderSecretKey,
  senderPublicKey,
  to,
  amount,
  parents,
  metadata = null,
  fee = null, // auto-calculated if null
}) {
  if (parents.length !== 2) {
    throw new Error('Transaction must reference exactly 2 parent transactions');
  }

  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }

  const from = publicKeyToAddress(senderPublicKey);
  const nonce = generateNonce();
  const timestamp = Date.now();
  const txFee = fee !== null ? fee : calculateFee(amount);

  // Fields that get hashed (deterministic)
  const hashableFields = {
    type: 'transfer',
    from,
    to,
    amount,
    fee: txFee,
    timestamp,
    nonce,
    parents: parents.sort(), // canonical order
  };

  if (metadata) {
    hashableFields.metadata = metadata;
  }

  const id = hashTransaction(hashableFields);

  // Sign the transaction hash
  const signature = sign(id, senderSecretKey);

  return {
    id,
    type: 'transfer',
    from,
    to,
    amount,
    fee: txFee,
    timestamp,
    nonce,
    parents: parents.sort(),
    senderPublicKey: encodePublicKey(senderPublicKey),
    signature,
    weight: 1,
    cumulativeWeight: 1,
    metadata,
  };
}

/**
 * Create a data-only transaction (no value transfer)
 * Used by AI agents to store messages, requests, or metadata on the DAG
 * @param {object} params
 * @param {Uint8Array} params.senderSecretKey
 * @param {Uint8Array} params.senderPublicKey
 * @param {string[]} params.parents
 * @param {object} params.metadata - the data payload
 * @returns {Transaction}
 */
export function createDataTransaction({
  senderSecretKey,
  senderPublicKey,
  parents,
  metadata,
}) {
  if (parents.length !== 2) {
    throw new Error('Transaction must reference exactly 2 parent transactions');
  }

  const from = publicKeyToAddress(senderPublicKey);
  const nonce = generateNonce();
  const timestamp = Date.now();

  const hashableFields = {
    type: 'data',
    from,
    to: from, // data tx sends to self
    amount: 0,
    timestamp,
    nonce,
    parents: parents.sort(),
    metadata,
  };

  const id = hashTransaction(hashableFields);
  const signature = sign(id, senderSecretKey);

  return {
    id,
    type: 'data',
    from,
    to: from,
    amount: 0,
    timestamp,
    nonce,
    parents: parents.sort(),
    senderPublicKey: encodePublicKey(senderPublicKey),
    signature,
    weight: 1,
    cumulativeWeight: 1,
    metadata,
  };
}

/**
 * Verify a transaction's signature and structural integrity
 * @param {Transaction} tx
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyTransaction(tx) {
  // Genesis has no signature
  if (tx.type === 'genesis') {
    return { valid: true };
  }

  // Must have exactly 2 parents
  if (!tx.parents || tx.parents.length !== 2) {
    return { valid: false, error: 'Must reference exactly 2 parents' };
  }

  // Amount validation
  if (tx.type === 'transfer' && tx.amount <= 0) {
    return { valid: false, error: 'Transfer amount must be positive' };
  }

  // Verify address matches public key
  const publicKey = decodePublicKey(tx.senderPublicKey);
  const expectedAddress = publicKeyToAddress(publicKey);
  if (tx.from !== expectedAddress) {
    return { valid: false, error: 'Address does not match public key' };
  }

  // Reconstruct hash and verify
  const hashableFields = {
    type: tx.type,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    timestamp: tx.timestamp,
    nonce: tx.nonce,
    parents: tx.parents,
  };

  // Include fee in hash for transfers that have it
  if (tx.type === 'transfer' && tx.fee !== undefined && tx.fee !== null) {
    hashableFields.fee = tx.fee;
  }

  if (tx.metadata) {
    hashableFields.metadata = tx.metadata;
  }

  const expectedId = hashTransaction(hashableFields);
  if (tx.id !== expectedId) {
    return { valid: false, error: 'Transaction hash mismatch' };
  }

  // Verify signature
  const isValid = verify(tx.id, tx.signature, publicKey);
  if (!isValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Serialize a transaction for network transport
 * @param {Transaction} tx
 * @returns {string} JSON string
 */
export function serializeTransaction(tx) {
  return JSON.stringify(tx);
}

/**
 * Deserialize a transaction from network transport
 * @param {string} json
 * @returns {Transaction}
 */
export function deserializeTransaction(json) {
  return JSON.parse(json);
}
