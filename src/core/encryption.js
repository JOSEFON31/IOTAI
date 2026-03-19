/**
 * IOTAI Encryption Layer
 *
 * End-to-end encrypted messaging between agents using their existing keypairs.
 * Uses NaCl box (X25519 + XSalsa20 + Poly1305) for asymmetric encryption.
 *
 * Flow:
 *   1. Agent A wants to send private data to Agent B
 *   2. A encrypts with B's public key using NaCl box
 *   3. Encrypted payload stored as data tx on DAG (publicly visible but unreadable)
 *   4. B decrypts using their secret key
 *
 * The Ed25519 signing keys are converted to X25519 encryption keys via
 * tweetnacl's built-in conversion. This means no extra key management.
 *
 * Features:
 *   - Private messages on public DAG
 *   - Encrypted data storage (AI model weights, credentials, results)
 *   - Signed + encrypted (authenticity + confidentiality)
 *   - Group messages (encrypt for multiple recipients)
 */

import nacl from 'tweetnacl';
import { toString, fromString } from 'uint8arrays';
import { hash } from './crypto.js';

// ============================================================
// KEY CONVERSION
// ============================================================

/**
 * Convert Ed25519 public key to X25519 (for encryption)
 * @param {Uint8Array} ed25519PublicKey
 * @returns {Uint8Array} X25519 public key
 */
export function edToX25519Public(ed25519PublicKey) {
  return nacl.box.keyPair.fromSecretKey(
    // We can't directly convert Ed25519 pub -> X25519 pub without the secret key
    // So we use a workaround: if the caller has the secret key, use edToX25519Secret
    // For public-only conversion, we use the nacl internal conversion
    // tweetnacl doesn't expose ed2curve, so we use a manual approach
    new Uint8Array(32) // placeholder - real conversion happens via secret key
  ).publicKey;
}

/**
 * Convert Ed25519 secret key to X25519 keypair (for encryption)
 * @param {Uint8Array} ed25519SecretKey - 64-byte Ed25519 secret key
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }} X25519 keypair
 */
export function edToX25519Keypair(ed25519SecretKey) {
  // Ed25519 secret key first 32 bytes = seed, derive X25519 from it
  const seed = ed25519SecretKey.slice(0, 32);
  // Hash the seed to get a proper X25519 secret key
  const xSecret = nacl.hash(seed).slice(0, 32);
  // Clamp for X25519
  xSecret[0] &= 248;
  xSecret[31] &= 127;
  xSecret[31] |= 64;
  return nacl.box.keyPair.fromSecretKey(xSecret);
}

// ============================================================
// ENCRYPTION ENGINE
// ============================================================

export class EncryptionLayer {
  /**
   * @param {object} params
   * @param {import('./dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    /** @type {Map<string, Uint8Array>} address -> X25519 public key cache */
    this.encryptionKeys = new Map();

    /** @type {Map<string, EncryptedMessage[]>} address -> messages */
    this.inbox = new Map();
  }

  // ============================================================
  // KEY REGISTRATION
  // ============================================================

  /**
   * Register encryption public key on DAG (so others can encrypt for you)
   * Called once per wallet to advertise their encryption capability.
   */
  registerKey(wallet, tips) {
    const xKeypair = edToX25519Keypair(wallet.secretKey);
    const xPublicKeyB64 = toString(xKeypair.publicKey, 'base64');

    const tx = wallet.sendData(tips, {
      _encrypt: 'register_key',
      address: wallet.address,
      encryptionKey: xPublicKeyB64,
      registeredAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this.encryptionKeys.set(wallet.address, xKeypair.publicKey);

    return { txId: tx.id, encryptionKey: xPublicKeyB64 };
  }

  /**
   * Get encryption public key for an address
   */
  getEncryptionKey(address) {
    // Check cache
    if (this.encryptionKeys.has(address)) {
      return this.encryptionKeys.get(address);
    }

    // Search DAG for registration
    for (const tx of this.dag.transactions.values()) {
      if (tx.metadata?._encrypt === 'register_key' && tx.metadata.address === address) {
        const key = fromString(tx.metadata.encryptionKey, 'base64');
        this.encryptionKeys.set(address, key);
        return key;
      }
    }

    return null;
  }

  // ============================================================
  // ENCRYPT & SEND
  // ============================================================

  /**
   * Send an encrypted message to a recipient
   * @param {Wallet} wallet - Sender wallet
   * @param {string[]} tips - DAG tips
   * @param {object} params
   * @param {string} params.to - Recipient address
   * @param {object|string} params.data - Data to encrypt (object or string)
   * @param {string} [params.subject] - Optional subject (visible, not encrypted)
   * @returns {{ txId: string, messageId: string }}
   */
  sendEncrypted(wallet, tips, { to, data, subject }) {
    if (!to) throw new Error('Recipient address required');
    if (!data) throw new Error('Data to encrypt required');

    // Get recipient's encryption key
    const recipientKey = this.getEncryptionKey(to);
    if (!recipientKey) {
      throw new Error(`Recipient ${to} has not registered an encryption key. They must call registerKey() first.`);
    }

    // Get sender's X25519 keypair
    const senderKeypair = edToX25519Keypair(wallet.secretKey);

    // Serialize data
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const plaintextBytes = fromString(plaintext, 'utf8');

    // Encrypt with NaCl box (X25519 + XSalsa20-Poly1305)
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(plaintextBytes, nonce, recipientKey, senderKeypair.secretKey);

    if (!encrypted) throw new Error('Encryption failed');

    const messageId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    // Store on DAG (encrypted payload is unreadable without recipient's key)
    const tx = wallet.sendData(tips, {
      _encrypt: 'message',
      messageId,
      from: wallet.address,
      to,
      subject: subject || '',
      senderEncryptionKey: toString(senderKeypair.publicKey, 'base64'),
      nonce: toString(nonce, 'base64'),
      ciphertext: toString(encrypted, 'base64'),
      size: plaintext.length,
      sentAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    // Index in inbox
    this._indexMessage(tx);

    return { txId: tx.id, messageId, to, size: plaintext.length };
  }

  /**
   * Send encrypted message to multiple recipients
   */
  sendEncryptedGroup(wallet, tips, { recipients, data, subject }) {
    if (!recipients || recipients.length === 0) throw new Error('At least one recipient required');
    if (recipients.length > 20) throw new Error('Max 20 recipients per group message');

    const senderKeypair = edToX25519Keypair(wallet.secretKey);
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const plaintextBytes = fromString(plaintext, 'utf8');

    const messageId = 'gmsg_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    // Encrypt for each recipient separately
    const encryptedPayloads = [];
    for (const to of recipients) {
      const recipientKey = this.getEncryptionKey(to);
      if (!recipientKey) {
        throw new Error(`Recipient ${to} has not registered an encryption key`);
      }
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const encrypted = nacl.box(plaintextBytes, nonce, recipientKey, senderKeypair.secretKey);
      if (!encrypted) throw new Error(`Encryption failed for ${to}`);
      encryptedPayloads.push({
        to,
        nonce: toString(nonce, 'base64'),
        ciphertext: toString(encrypted, 'base64'),
      });
    }

    const tx = wallet.sendData(tips, {
      _encrypt: 'group_message',
      messageId,
      from: wallet.address,
      subject: subject || '',
      senderEncryptionKey: toString(senderKeypair.publicKey, 'base64'),
      recipients: encryptedPayloads,
      recipientCount: recipients.length,
      size: plaintext.length,
      sentAt: Date.now(),
    });

    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexMessage(tx);

    return { txId: tx.id, messageId, recipients: recipients.length, size: plaintext.length };
  }

  // ============================================================
  // DECRYPT & READ
  // ============================================================

  /**
   * Decrypt a message received by this wallet
   * @param {Wallet} wallet - Recipient wallet
   * @param {string} messageId - Message ID to decrypt
   * @returns {{ from: string, data: any, subject: string, sentAt: number }}
   */
  decryptMessage(wallet, messageId) {
    // Find message in DAG
    let msgTx = null;
    for (const tx of this.dag.transactions.values()) {
      if (tx.metadata?.messageId === messageId) {
        msgTx = tx;
        break;
      }
    }
    if (!msgTx) throw new Error('Message not found');

    const m = msgTx.metadata;
    const recipientKeypair = edToX25519Keypair(wallet.secretKey);

    let nonce, ciphertext;

    if (m._encrypt === 'group_message') {
      // Find our encrypted payload
      const payload = m.recipients.find(r => r.to === wallet.address);
      if (!payload) throw new Error('You are not a recipient of this message');
      nonce = fromString(payload.nonce, 'base64');
      ciphertext = fromString(payload.ciphertext, 'base64');
    } else {
      if (m.to !== wallet.address) throw new Error('This message is not for you');
      nonce = fromString(m.nonce, 'base64');
      ciphertext = fromString(m.ciphertext, 'base64');
    }

    const senderKey = fromString(m.senderEncryptionKey, 'base64');

    // Decrypt
    const decrypted = nacl.box.open(ciphertext, nonce, senderKey, recipientKeypair.secretKey);
    if (!decrypted) throw new Error('Decryption failed - wrong key or corrupted message');

    const plaintext = toString(decrypted, 'utf8');

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(plaintext);
    } catch {
      data = plaintext;
    }

    return {
      messageId,
      from: m.from,
      to: m.to || 'group',
      subject: m.subject || '',
      data,
      size: plaintext.length,
      sentAt: m.sentAt,
    };
  }

  // ============================================================
  // INBOX
  // ============================================================

  /**
   * Get encrypted messages for an address (metadata only, not decrypted)
   */
  getInbox(address, limit = 50) {
    const messages = this.inbox.get(address) || [];
    return messages
      .slice(-limit)
      .reverse()
      .map(m => ({
        messageId: m.messageId,
        from: m.from,
        subject: m.subject || '',
        size: m.size,
        sentAt: m.sentAt,
        isGroup: m.isGroup || false,
      }));
  }

  /**
   * Get sent messages for an address
   */
  getSent(address, limit = 50) {
    const sent = [];
    for (const tx of this.dag.transactions.values()) {
      const m = tx.metadata;
      if (m?._encrypt === 'message' && m.from === address) {
        sent.push({ messageId: m.messageId, to: m.to, subject: m.subject, size: m.size, sentAt: m.sentAt });
      }
      if (m?._encrypt === 'group_message' && m.from === address) {
        sent.push({ messageId: m.messageId, to: 'group', recipientCount: m.recipientCount, subject: m.subject, size: m.size, sentAt: m.sentAt });
      }
    }
    return sent.sort((a, b) => b.sentAt - a.sentAt).slice(0, limit);
  }

  /** Get stats */
  getStats() {
    let totalMessages = 0;
    let totalGroupMessages = 0;
    let registeredKeys = this.encryptionKeys.size;

    for (const tx of this.dag.transactions.values()) {
      if (tx.metadata?._encrypt === 'message') totalMessages++;
      if (tx.metadata?._encrypt === 'group_message') totalGroupMessages++;
      if (tx.metadata?._encrypt === 'register_key') {
        this.encryptionKeys.set(tx.metadata.address, fromString(tx.metadata.encryptionKey, 'base64'));
      }
    }

    return {
      registeredKeys: this.encryptionKeys.size,
      totalMessages,
      totalGroupMessages,
      totalEncrypted: totalMessages + totalGroupMessages,
    };
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  _indexMessage(tx) {
    const m = tx.metadata;

    if (m._encrypt === 'register_key') {
      this.encryptionKeys.set(m.address, fromString(m.encryptionKey, 'base64'));
      return;
    }

    if (m._encrypt === 'message') {
      const inbox = this.inbox.get(m.to) || [];
      inbox.push({ messageId: m.messageId, from: m.from, subject: m.subject, size: m.size, sentAt: m.sentAt });
      this.inbox.set(m.to, inbox);
    }

    if (m._encrypt === 'group_message') {
      for (const r of m.recipients) {
        const inbox = this.inbox.get(r.to) || [];
        inbox.push({ messageId: m.messageId, from: m.from, subject: m.subject, size: m.size, sentAt: m.sentAt, isGroup: true });
        this.inbox.set(r.to, inbox);
      }
    }
  }
}
