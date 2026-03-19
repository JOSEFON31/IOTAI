import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  deriveKeyPair,
  seedFromPassphrase,
  hash,
  hashTransaction,
  sign,
  verify,
  generateNonce,
  publicKeyToAddress,
  encodePublicKey,
  decodePublicKey,
} from '../src/core/crypto.js';

describe('generateKeyPair', () => {
  it('returns publicKey and secretKey', () => {
    const pair = generateKeyPair();
    assert.ok(pair.publicKey instanceof Uint8Array);
    assert.ok(pair.secretKey instanceof Uint8Array);
    assert.equal(pair.publicKey.length, 32);
    assert.equal(pair.secretKey.length, 64);
  });

  it('generates unique keypairs each time', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    assert.notDeepEqual(a.publicKey, b.publicKey);
  });
});

describe('deriveKeyPair', () => {
  it('derives deterministic keypairs from seed + index', () => {
    const seed = seedFromPassphrase('test-seed');
    const pair1 = deriveKeyPair(seed, 0);
    const pair2 = deriveKeyPair(seed, 0);
    assert.deepEqual(pair1.publicKey, pair2.publicKey);
    assert.deepEqual(pair1.secretKey, pair2.secretKey);
  });

  it('different indices produce different keys', () => {
    const seed = seedFromPassphrase('test-seed');
    const pair0 = deriveKeyPair(seed, 0);
    const pair1 = deriveKeyPair(seed, 1);
    assert.notDeepEqual(pair0.publicKey, pair1.publicKey);
  });

  it('different seeds produce different keys', () => {
    const seed1 = seedFromPassphrase('seed-a');
    const seed2 = seedFromPassphrase('seed-b');
    const pair1 = deriveKeyPair(seed1, 0);
    const pair2 = deriveKeyPair(seed2, 0);
    assert.notDeepEqual(pair1.publicKey, pair2.publicKey);
  });
});

describe('seedFromPassphrase', () => {
  it('returns a 32-byte Uint8Array', () => {
    const seed = seedFromPassphrase('hello');
    assert.ok(seed instanceof Uint8Array);
    assert.equal(seed.length, 32);
  });

  it('is deterministic', () => {
    const a = seedFromPassphrase('same');
    const b = seedFromPassphrase('same');
    assert.deepEqual(a, b);
  });

  it('different passphrases yield different seeds', () => {
    const a = seedFromPassphrase('alpha');
    const b = seedFromPassphrase('beta');
    assert.notDeepEqual(a, b);
  });
});

describe('hash', () => {
  it('returns a hex string', () => {
    const h = hash('hello');
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    assert.equal(hash('test'), hash('test'));
  });

  it('different inputs produce different hashes', () => {
    assert.notEqual(hash('a'), hash('b'));
  });

  it('accepts Uint8Array input', () => {
    const h = hash(new Uint8Array([1, 2, 3]));
    assert.match(h, /^[0-9a-f]+$/);
  });
});

describe('hashTransaction', () => {
  it('produces consistent hash for same fields', () => {
    const data = { type: 'transfer', from: 'a', to: 'b', amount: 100 };
    assert.equal(hashTransaction(data), hashTransaction(data));
  });

  it('sorts keys canonically (order-independent)', () => {
    const h1 = hashTransaction({ a: 1, b: 2 });
    const h2 = hashTransaction({ b: 2, a: 1 });
    assert.equal(h1, h2);
  });
});

describe('sign and verify', () => {
  it('valid signature verifies correctly', () => {
    const pair = generateKeyPair();
    const message = 'hello world';
    const sig = sign(message, pair.secretKey);
    assert.ok(verify(message, sig, pair.publicKey));
  });

  it('wrong message fails verification', () => {
    const pair = generateKeyPair();
    const sig = sign('correct', pair.secretKey);
    assert.ok(!verify('wrong', sig, pair.publicKey));
  });

  it('wrong key fails verification', () => {
    const pair1 = generateKeyPair();
    const pair2 = generateKeyPair();
    const sig = sign('data', pair1.secretKey);
    assert.ok(!verify('data', sig, pair2.publicKey));
  });
});

describe('generateNonce', () => {
  it('returns a hex string', () => {
    const n = generateNonce();
    assert.match(n, /^[0-9a-f]+$/);
  });

  it('generates unique nonces', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    assert.equal(nonces.size, 100);
  });
});

describe('publicKeyToAddress', () => {
  it('returns iotai_ prefixed address', () => {
    const pair = generateKeyPair();
    const addr = publicKeyToAddress(pair.publicKey);
    assert.match(addr, /^iotai_[0-9a-f]{40}$/);
  });

  it('is deterministic', () => {
    const pair = generateKeyPair();
    assert.equal(
      publicKeyToAddress(pair.publicKey),
      publicKeyToAddress(pair.publicKey)
    );
  });
});

describe('encodePublicKey / decodePublicKey', () => {
  it('round-trips correctly', () => {
    const pair = generateKeyPair();
    const encoded = encodePublicKey(pair.publicKey);
    const decoded = decodePublicKey(encoded);
    assert.deepEqual(decoded, pair.publicKey);
  });

  it('encoded form is a base64 string', () => {
    const pair = generateKeyPair();
    const encoded = encodePublicKey(pair.publicKey);
    assert.equal(typeof encoded, 'string');
    assert.ok(encoded.length > 0);
  });
});
