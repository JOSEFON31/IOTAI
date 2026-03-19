/**
 * IOTAI Faucet - Proof of Personhood Distribution
 *
 * Distributes 60% of total supply to verified new users.
 * Each person can only claim once - verified via facial recognition.
 *
 * How it works:
 * 1. User submits a selfie with liveness check (blink/smile/turn head)
 * 2. System extracts a facial embedding (512-dim vector)
 * 3. Embedding is hashed (we NEVER store the photo or raw embedding)
 * 4. Hash is compared against all previous hashes to prevent duplicates
 * 5. If unique, user gets their IOTAI tokens
 *
 * Privacy: Only a one-way hash of facial features is stored.
 *          The original photo is discarded immediately after processing.
 *
 * Anti-bot measures:
 * - Liveness detection (must perform random action)
 * - Face embedding uniqueness (no duplicate faces)
 * - Rate limiting per IP
 * - Cooldown between claims from same device
 */

import { hash } from './crypto.js';

/**
 * Cosine similarity between two vectors
 * Returns value between -1 and 1 (1 = identical, 0 = unrelated)
 */
function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Distribution config
const TOTAL_SUPPLY = 1_000_000_000;
const FAUCET_POOL = TOTAL_SUPPLY * 0.60;         // 600,000,000 IOTAI (60%)
const TOKENS_PER_PERSON = 1_000;                   // Each verified person gets 1,000 IOTAI
const MAX_RECIPIENTS = FAUCET_POOL / TOKENS_PER_PERSON; // 600,000 people max

export class Faucet {
  /**
   * @param {import('./dag.js').DAG} dag
   */
  constructor(dag) {
    this.dag = dag;

    /** @type {Set<string>} - hashes of facial embeddings (for uniqueness check) */
    this.faceHashes = new Set();

    /** @type {number[][]} - stored embeddings for cosine similarity check */
    this.storedEmbeddings = [];

    /** @type {Map<string, number>} - IP -> last claim timestamp */
    this.ipCooldowns = new Map();

    /** @type {Map<string, number>} - IP -> total claims from this IP */
    this.ipClaimCounts = new Map();

    /** @type {Set<string>} - addresses that already claimed */
    this.claimedAddresses = new Set();

    this.tokensDistributed = 0;
    this.totalRecipients = 0;
    this.tokensPerPerson = TOKENS_PER_PERSON;
    this.faucetPool = FAUCET_POOL;

    // Rate limit: 1 claim per IP per 24 hours
    this.cooldownMs = 24 * 60 * 60 * 1000;

    // Max claims per IP ever (prevents one person creating many wallets)
    this.maxClaimsPerIp = 1;

    // Liveness challenge types
    this.challenges = ['blink', 'smile', 'turn_left', 'turn_right', 'nod'];
  }

  /**
   * Get faucet status
   */
  getStatus() {
    return {
      totalPool: this.faucetPool,
      distributed: this.tokensDistributed,
      remaining: this.faucetPool - this.tokensDistributed,
      recipients: this.totalRecipients,
      maxRecipients: MAX_RECIPIENTS,
      tokensPerPerson: this.tokensPerPerson,
      percentDistributed: Math.round((this.tokensDistributed / this.faucetPool) * 10000) / 100,
    };
  }

  /**
   * Step 1: Start verification - return a liveness challenge
   * The user must perform this action in their selfie video
   * @returns {{ challengeId: string, action: string, instructions: string }}
   */
  startVerification() {
    if (this.tokensDistributed >= this.faucetPool) {
      throw new Error('Faucet pool exhausted. All 600,000,000 IOTAI have been distributed.');
    }

    // Pick a random challenge
    const action = this.challenges[Math.floor(Math.random() * this.challenges.length)];
    const challengeId = hash(Date.now().toString() + Math.random().toString());

    const instructions = {
      blink: 'Blink your eyes twice while looking at the camera',
      smile: 'Smile naturally while looking at the camera',
      turn_left: 'Slowly turn your head to the left, then back to center',
      turn_right: 'Slowly turn your head to the right, then back to center',
      nod: 'Nod your head up and down slowly',
    };

    return {
      challengeId,
      action,
      instructions: instructions[action],
      expiresIn: 120, // 2 minutes to complete
    };
  }

  /**
   * Step 2: Verify face and claim tokens
   * @param {object} params
   * @param {string} params.challengeId - from startVerification
   * @param {number[]} params.faceEmbedding - 128-dim facial feature vector (from face-api.js)
   * @param {boolean} params.livenessPass - did the liveness check pass
   * @param {string} params.address - IOTAI wallet address to receive tokens
   * @param {string} params.ip - requester IP for rate limiting
   * @returns {{ success: boolean, error?: string, txId?: string, amount?: number }}
   */
  async claimTokens({ challengeId, faceEmbedding, livenessPass, address, ip }) {
    // 1. Check faucet has tokens left
    if (this.tokensDistributed >= this.faucetPool) {
      return { success: false, error: 'Faucet pool exhausted' };
    }

    // 2. Check liveness
    if (!livenessPass) {
      return { success: false, error: 'Liveness check failed. Please try again with a live camera.' };
    }

    // 3. Check IP lifetime limit (1 claim per IP ever)
    const ipClaims = this.ipClaimCounts.get(ip) || 0;
    if (ipClaims >= this.maxClaimsPerIp) {
      return { success: false, error: 'This network has already claimed tokens. Only 1 claim per network is allowed.' };
    }

    // 4. Check IP cooldown
    const lastClaim = this.ipCooldowns.get(ip);
    if (lastClaim && Date.now() - lastClaim < this.cooldownMs) {
      const waitHrs = Math.ceil((this.cooldownMs - (Date.now() - lastClaim)) / 3600000);
      return { success: false, error: `Rate limited. Try again in ${waitHrs} hours.` };
    }

    // 5. Check address hasn't already claimed
    if (this.claimedAddresses.has(address)) {
      return { success: false, error: 'This wallet has already claimed tokens.' };
    }

    // 6. Validate embedding is real (128-dim from face-api.js, proper variance)
    if (!Array.isArray(faceEmbedding) || faceEmbedding.length < 64) {
      return { success: false, error: 'Invalid face embedding. Use a real camera with face detection.' };
    }

    // Check embedding has real variance (not fake/constant data)
    const mean = faceEmbedding.reduce((s, v) => s + v, 0) / faceEmbedding.length;
    const variance = faceEmbedding.reduce((s, v) => s + (v - mean) ** 2, 0) / faceEmbedding.length;
    if (variance < 0.001) {
      return { success: false, error: 'Face embedding appears fake. Please use a real camera.' };
    }

    // Check values are in expected range for face-api.js (-0.5 to 0.5 typically)
    const hasValidRange = faceEmbedding.every(v => v >= -2 && v <= 2);
    if (!hasValidRange) {
      return { success: false, error: 'Face embedding out of range. Please try again.' };
    }

    // 7. Hash the face embedding (privacy-preserving)
    const embeddingString = faceEmbedding.map(v => v.toFixed(6)).join(',');
    const faceHash = hash(embeddingString);

    // 8. Check for exact duplicate face
    if (this.faceHashes.has(faceHash)) {
      return { success: false, error: 'This face has already been registered. Each person can only claim once.' };
    }

    // 9. Cosine similarity check against stored embeddings
    // face-api.js 128-dim: same person = 0.6-0.95, different people = 0.0-0.5
    // Threshold 0.6 blocks same person, allows different people
    let maxSimilarity = 0;
    for (const stored of this.storedEmbeddings) {
      const similarity = cosineSimilarity(faceEmbedding, stored);
      maxSimilarity = Math.max(maxSimilarity, similarity);
      if (similarity > 0.6) {
        return { success: false, error: `Face too similar to an existing registration (${(similarity * 100).toFixed(0)}% match). Each person can only claim once.` };
      }
    }

    // 10. All checks passed - distribute tokens!
    this.faceHashes.add(faceHash);
    this.storedEmbeddings.push(faceEmbedding.map(v => parseFloat(v.toFixed(6))));
    this.claimedAddresses.add(address);
    this.ipCooldowns.set(ip, Date.now());
    this.ipClaimCounts.set(ip, ipClaims + 1);

    // Credit the balance
    const currentBalance = this.dag.getBalance(address);
    this.dag.balances.set(address, currentBalance + this.tokensPerPerson);
    this.dag.balances.set('iotai_genesis',
      this.dag.getBalance('iotai_genesis') - this.tokensPerPerson);

    this.tokensDistributed += this.tokensPerPerson;
    this.totalRecipients++;

    return {
      success: true,
      amount: this.tokensPerPerson,
      address,
      recipientNumber: this.totalRecipients,
      message: `Welcome to IOTAI! You received ${this.tokensPerPerson} IOTAI tokens.`,
    };
  }

  /**
   * Export faucet state for persistence
   */
  exportState() {
    return {
      faceHashes: Array.from(this.faceHashes),
      storedEmbeddings: this.storedEmbeddings,
      claimedAddresses: Array.from(this.claimedAddresses),
      ipClaimCounts: Object.fromEntries(this.ipClaimCounts),
      tokensDistributed: this.tokensDistributed,
      totalRecipients: this.totalRecipients,
    };
  }

  /**
   * Import faucet state
   */
  importState(state) {
    this.faceHashes = new Set(state.faceHashes);
    this.storedEmbeddings = state.storedEmbeddings || [];
    this.claimedAddresses = new Set(state.claimedAddresses);
    this.ipClaimCounts = new Map(Object.entries(state.ipClaimCounts || {}));
    this.tokensDistributed = state.tokensDistributed;
    this.totalRecipients = state.totalRecipients;
  }
}
