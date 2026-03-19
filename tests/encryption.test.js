import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { EncryptionLayer } from '../src/core/encryption.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const alice = new Wallet({ passphrase: 'encrypt-alice-test' });
  const bob = new Wallet({ passphrase: 'encrypt-bob-test' });
  const charlie = new Wallet({ passphrase: 'encrypt-charlie-test' });
  dag.balances.set(alice.address, 10_000);
  dag.balances.set(bob.address, 10_000);
  dag.balances.set(charlie.address, 10_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 30_000);
  const encryption = new EncryptionLayer({ dag });
  return { dag, alice, bob, charlie, encryption };
}

describe('Encryption - Key Registration', () => {
  it('registers encryption key on DAG', () => {
    const { dag, alice, encryption } = setup();
    const result = encryption.registerKey(alice, dag.selectTips());
    assert.ok(result.txId);
    assert.ok(result.encryptionKey);

    const key = encryption.getEncryptionKey(alice.address);
    assert.ok(key);
    assert.equal(key.length, 32); // X25519 key is 32 bytes
  });

  it('returns null for unregistered address', () => {
    const { encryption } = setup();
    assert.equal(encryption.getEncryptionKey('iotai_nobody'), null);
  });
});

describe('Encryption - Send & Decrypt', () => {
  it('encrypts and decrypts a message (string)', () => {
    const { dag, alice, bob, encryption } = setup();

    // Both register keys
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());

    // Alice sends encrypted message to Bob
    const sent = encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: 'Hello Bob, this is secret!',
      subject: 'Secret Message',
    });
    assert.ok(sent.txId);
    assert.ok(sent.messageId);

    // Bob decrypts
    const decrypted = encryption.decryptMessage(bob, sent.messageId);
    assert.equal(decrypted.data, 'Hello Bob, this is secret!');
    assert.equal(decrypted.from, alice.address);
    assert.equal(decrypted.subject, 'Secret Message');
  });

  it('encrypts and decrypts an object', () => {
    const { dag, alice, bob, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());

    const secretData = { model: 'gpt-4', weights: [0.1, 0.9], accuracy: 0.97 };
    const sent = encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: secretData,
    });

    const decrypted = encryption.decryptMessage(bob, sent.messageId);
    assert.deepEqual(decrypted.data, secretData);
  });

  it('wrong recipient cannot decrypt', () => {
    const { dag, alice, bob, charlie, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());
    encryption.registerKey(charlie, dag.selectTips());

    const sent = encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: 'For Bob only',
    });

    assert.throws(() => {
      encryption.decryptMessage(charlie, sent.messageId);
    }, /not for you/);
  });

  it('fails without registered key', () => {
    const { dag, alice, bob, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    // Bob does NOT register

    assert.throws(() => {
      encryption.sendEncrypted(alice, dag.selectTips(), {
        to: bob.address,
        data: 'Will fail',
      });
    }, /not registered/);
  });
});

describe('Encryption - Group Messages', () => {
  it('sends encrypted message to multiple recipients', () => {
    const { dag, alice, bob, charlie, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());
    encryption.registerKey(charlie, dag.selectTips());

    const sent = encryption.sendEncryptedGroup(alice, dag.selectTips(), {
      recipients: [bob.address, charlie.address],
      data: { announcement: 'Team meeting at 3pm' },
      subject: 'Meeting',
    });

    assert.equal(sent.recipients, 2);

    // Bob decrypts
    const bobMsg = encryption.decryptMessage(bob, sent.messageId);
    assert.equal(bobMsg.data.announcement, 'Team meeting at 3pm');

    // Charlie decrypts
    const charlieMsg = encryption.decryptMessage(charlie, sent.messageId);
    assert.equal(charlieMsg.data.announcement, 'Team meeting at 3pm');
  });
});

describe('Encryption - Inbox', () => {
  it('getInbox returns messages for address', () => {
    const { dag, alice, bob, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());

    encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: 'msg1',
      subject: 'First',
    });
    encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: 'msg2',
      subject: 'Second',
    });

    const inbox = encryption.getInbox(bob.address);
    assert.equal(inbox.length, 2);
    assert.equal(inbox[0].subject, 'Second'); // newest first
    assert.equal(inbox[1].subject, 'First');
  });

  it('getSent returns sent messages', () => {
    const { dag, alice, bob, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());

    encryption.sendEncrypted(alice, dag.selectTips(), {
      to: bob.address,
      data: 'test',
    });

    const sent = encryption.getSent(alice.address);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, bob.address);
  });

  it('stats are correct', () => {
    const { dag, alice, bob, encryption } = setup();
    encryption.registerKey(alice, dag.selectTips());
    encryption.registerKey(bob, dag.selectTips());
    encryption.sendEncrypted(alice, dag.selectTips(), { to: bob.address, data: 'hi' });

    const stats = encryption.getStats();
    assert.equal(stats.registeredKeys, 2);
    assert.equal(stats.totalMessages, 1);
  });
});
