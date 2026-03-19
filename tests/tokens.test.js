import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DAG } from '../src/core/dag.js';
import { Wallet } from '../src/wallet/wallet.js';
import { TokenManager } from '../src/tokens/token-manager.js';

function setup() {
  const dag = new DAG();
  dag.initialize(1_000_000_000);
  const creator = new Wallet({ passphrase: 'token-creator-test' });
  const user = new Wallet({ passphrase: 'token-user-test' });
  dag.balances.set(creator.address, 100_000);
  dag.balances.set(user.address, 10_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 110_000);
  const tokens = new TokenManager({ dag });
  return { dag, creator, user, tokens };
}

describe('Tokens - Create', () => {
  it('creates a token with full supply to creator', () => {
    const { dag, creator, tokens } = setup();
    const result = tokens.createToken(creator, dag.selectTips(), {
      name: 'Reputation Points',
      symbol: 'REP',
      totalSupply: 1_000_000,
      decimals: 2,
    });
    assert.ok(result.tokenId);
    assert.equal(result.symbol, 'REP');
    assert.equal(tokens.getBalance(result.tokenId, creator.address), 1_000_000);
  });

  it('rejects duplicate symbol', () => {
    const { dag, creator, tokens } = setup();
    tokens.createToken(creator, dag.selectTips(), { name: 'A', symbol: 'DUP', totalSupply: 100 });
    assert.throws(() => {
      tokens.createToken(creator, dag.selectTips(), { name: 'B', symbol: 'dup', totalSupply: 100 });
    }, /already exists/);
  });

  it('rejects missing name or symbol', () => {
    const { dag, creator, tokens } = setup();
    assert.throws(() => {
      tokens.createToken(creator, dag.selectTips(), { name: '', symbol: 'X', totalSupply: 100 });
    }, /required/);
  });
});

describe('Tokens - Transfer', () => {
  it('transfers tokens between addresses', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Credits', symbol: 'CRD', totalSupply: 10_000,
    });

    tokens.transfer(creator, dag.selectTips(), { tokenId, to: user.address, amount: 3000 });
    assert.equal(tokens.getBalance(tokenId, creator.address), 7000);
    assert.equal(tokens.getBalance(tokenId, user.address), 3000);
  });

  it('rejects insufficient balance', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Limited', symbol: 'LMT', totalSupply: 100,
    });
    assert.throws(() => {
      tokens.transfer(creator, dag.selectTips(), { tokenId, to: user.address, amount: 200 });
    }, /Insufficient/);
  });

  it('rejects non-transferable tokens', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Soul', symbol: 'SBT', totalSupply: 1, transferable: false,
    });
    assert.throws(() => {
      tokens.transfer(creator, dag.selectTips(), { tokenId, to: user.address, amount: 1 });
    }, /non-transferable/);
  });
});

describe('Tokens - Mint & Burn', () => {
  it('creator can mint additional tokens', () => {
    const { dag, creator, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Mintable', symbol: 'MNT', totalSupply: 1000,
    });

    tokens.mint(creator, dag.selectTips(), { tokenId, amount: 500 });
    assert.equal(tokens.getBalance(tokenId, creator.address), 1500);
    assert.equal(tokens.getToken(tokenId).totalSupply, 1500);
  });

  it('non-creator cannot mint', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Owned', symbol: 'OWN', totalSupply: 1000,
    });
    assert.throws(() => {
      tokens.mint(user, dag.selectTips(), { tokenId, amount: 100 });
    }, /Only creator/);
  });

  it('burns tokens reducing supply', () => {
    const { dag, creator, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Burnable', symbol: 'BRN', totalSupply: 5000,
    });

    tokens.burn(creator, dag.selectTips(), { tokenId, amount: 2000 });
    assert.equal(tokens.getBalance(tokenId, creator.address), 3000);
    assert.equal(tokens.getToken(tokenId).totalSupply, 3000);
  });
});

describe('Tokens - Queries', () => {
  it('getBalances returns all token balances for address', () => {
    const { dag, creator, tokens } = setup();
    tokens.createToken(creator, dag.selectTips(), { name: 'A', symbol: 'AAA', totalSupply: 100 });
    tokens.createToken(creator, dag.selectTips(), { name: 'B', symbol: 'BBB', totalSupply: 200 });

    const balances = tokens.getBalances(creator.address);
    assert.equal(balances.length, 2);
    assert.ok(balances.find(b => b.symbol === 'AAA' && b.balance === 100));
    assert.ok(balances.find(b => b.symbol === 'BBB' && b.balance === 200));
  });

  it('getHolders returns sorted holders', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Holders', symbol: 'HLD', totalSupply: 1000,
    });
    tokens.transfer(creator, dag.selectTips(), { tokenId, to: user.address, amount: 300 });

    const holders = tokens.getHolders(tokenId);
    assert.equal(holders.length, 2);
    assert.equal(holders[0].balance, 700); // creator
    assert.equal(holders[1].balance, 300); // user
  });

  it('getTokenBySymbol works', () => {
    const { dag, creator, tokens } = setup();
    tokens.createToken(creator, dag.selectTips(), { name: 'FindMe', symbol: 'FIND', totalSupply: 42 });
    const found = tokens.getTokenBySymbol('find');
    assert.equal(found.name, 'FindMe');
    assert.equal(found.totalSupply, 42);
  });

  it('stats returns correct counts', () => {
    const { dag, creator, user, tokens } = setup();
    const { tokenId } = tokens.createToken(creator, dag.selectTips(), {
      name: 'Stats', symbol: 'STS', totalSupply: 1000,
    });
    tokens.transfer(creator, dag.selectTips(), { tokenId, to: user.address, amount: 100 });

    const stats = tokens.getStats();
    assert.equal(stats.totalTokens, 1);
    assert.equal(stats.totalTransfers, 1);
  });
});
