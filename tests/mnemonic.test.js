import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMnemonic,
  mnemonicToSeed,
  validateMnemonic,
} from '../src/core/mnemonic.js';

describe('generateMnemonic', () => {
  it('returns 12 words', () => {
    const m = generateMnemonic();
    assert.equal(m.split(' ').length, 12);
  });

  it('generates unique mnemonics', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    assert.notEqual(a, b);
  });
});

describe('mnemonicToSeed', () => {
  it('returns a 32-byte Uint8Array', () => {
    const m = generateMnemonic();
    const seed = mnemonicToSeed(m);
    assert.ok(seed instanceof Uint8Array);
    assert.equal(seed.length, 32);
  });

  it('is deterministic', () => {
    const m = generateMnemonic();
    const s1 = mnemonicToSeed(m);
    const s2 = mnemonicToSeed(m);
    assert.deepEqual(s1, s2);
  });

  it('normalizes whitespace', () => {
    const m = generateMnemonic();
    const s1 = mnemonicToSeed(m);
    const s2 = mnemonicToSeed('  ' + m.replace(/ /g, '  ') + '  ');
    assert.deepEqual(s1, s2);
  });

  it('normalizes case', () => {
    const m = generateMnemonic();
    const s1 = mnemonicToSeed(m);
    const s2 = mnemonicToSeed(m.toUpperCase());
    assert.deepEqual(s1, s2);
  });
});

describe('validateMnemonic', () => {
  it('accepts a valid 12-word mnemonic', () => {
    const m = generateMnemonic();
    const result = validateMnemonic(m);
    assert.ok(result.valid);
  });

  it('rejects null/undefined', () => {
    assert.ok(!validateMnemonic(null).valid);
    assert.ok(!validateMnemonic(undefined).valid);
  });

  it('rejects wrong word count', () => {
    const result = validateMnemonic('one two three');
    assert.ok(!result.valid);
    assert.match(result.error, /12 words/);
  });

  it('rejects invalid BIP39 words', () => {
    const result = validateMnemonic(
      'zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz'
    );
    assert.ok(!result.valid);
    assert.match(result.error, /wordlist/i);
  });

  it('rejects non-string', () => {
    assert.ok(!validateMnemonic(123).valid);
  });
});
