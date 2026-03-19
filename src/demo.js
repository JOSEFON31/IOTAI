/**
 * IOTAI Demo - Local simulation
 *
 * Demonstrates the core functionality without needing a network:
 * - Creating wallets for AI agents
 * - Making transactions between agents
 * - DAG structure and tip selection
 * - Balance tracking
 */

import { DAG } from './core/dag.js';
import { Wallet } from './wallet/wallet.js';
import { verifyTransaction } from './core/transaction.js';

async function demo() {
  console.log('=== IOTAI Demo: AI Agent Payments ===\n');

  // 1. Initialize the DAG
  const dag = new DAG();
  const genesis = dag.initialize(1_000_000_000);
  console.log(`Genesis created: ${genesis.id.substring(0, 20)}...`);
  console.log(`Total supply: 1,000,000,000 IOTAI\n`);

  // 2. Create wallets for 3 AI agents
  const agent1 = new Wallet({ passphrase: 'agent-alpha-secret-key-2024' });
  const agent2 = new Wallet({ passphrase: 'agent-beta-secret-key-2024' });
  const agent3 = new Wallet({ passphrase: 'agent-gamma-secret-key-2024' });

  console.log('AI Agent Wallets:');
  console.log(`  Agent Alpha: ${agent1.address}`);
  console.log(`  Agent Beta:  ${agent2.address}`);
  console.log(`  Agent Gamma: ${agent3.address}\n`);

  // 3. Fund agents from genesis (simulating initial distribution)
  // In production, this would be a faucet or initial allocation
  dag.balances.set(agent1.address, 10_000);
  dag.balances.set(agent2.address, 5_000);
  dag.balances.set(agent3.address, 2_000);
  dag.balances.set('iotai_genesis', 1_000_000_000 - 17_000);

  console.log('Initial balances:');
  console.log(`  Agent Alpha: ${dag.getBalance(agent1.address)} IOTAI`);
  console.log(`  Agent Beta:  ${dag.getBalance(agent2.address)} IOTAI`);
  console.log(`  Agent Gamma: ${dag.getBalance(agent3.address)} IOTAI\n`);

  // 4. Agent Alpha pays Agent Beta 100 IOTAI for an API call
  console.log('--- Transaction 1: Alpha pays Beta 100 IOTAI for API access ---');
  const tips1 = dag.selectTips();
  const tx1 = agent1.send(agent2.address, 100, tips1, {
    purpose: 'API access payment',
    service: 'data-analysis-v2',
    agentId: 'alpha-001',
  });

  // Verify the transaction
  const v1 = verifyTransaction(tx1);
  console.log(`  Signature valid: ${v1.valid}`);

  const r1 = dag.addTransaction(tx1);
  console.log(`  Added to DAG: ${r1.success}`);
  console.log(`  TX ID: ${tx1.id.substring(0, 20)}...`);
  console.log(`  Parents: ${tips1.map(t => t.substring(0, 12)).join(', ')}\n`);

  // 5. Agent Beta pays Agent Gamma 50 IOTAI for compute
  console.log('--- Transaction 2: Beta pays Gamma 50 IOTAI for compute ---');
  const tips2 = dag.selectTips();
  const tx2 = agent2.send(agent3.address, 50, tips2, {
    purpose: 'GPU compute rental',
    duration: '1 hour',
    agentId: 'beta-002',
  });

  const r2 = dag.addTransaction(tx2);
  console.log(`  Added to DAG: ${r2.success}`);
  console.log(`  TX ID: ${tx2.id.substring(0, 20)}...\n`);

  // 6. Agent Gamma stores data on the DAG (zero-value transaction)
  console.log('--- Transaction 3: Gamma stores a data message ---');
  const tips3 = dag.selectTips();
  const tx3 = agent3.sendData(tips3, {
    type: 'agent-service-listing',
    name: 'Gamma Compute Service',
    capabilities: ['image-generation', 'llm-inference', 'data-analysis'],
    pricePerHour: 25,
    currency: 'IOTAI',
  });

  const r3 = dag.addTransaction(tx3);
  console.log(`  Added to DAG: ${r3.success}`);
  console.log(`  Data stored: ${JSON.stringify(tx3.metadata).substring(0, 60)}...\n`);

  // 7. Multiple rapid transactions to show the DAG growing
  console.log('--- Transactions 4-8: Rapid agent-to-agent payments ---');
  for (let i = 0; i < 5; i++) {
    const tips = dag.selectTips();
    const sender = [agent1, agent2, agent3][i % 3];
    const receiver = [agent2, agent3, agent1][i % 3];
    const amount = 10 + i * 5;

    const tx = sender.send(receiver.address, amount, tips, {
      purpose: `automated-payment-${i + 4}`,
    });
    const result = dag.addTransaction(tx);
    console.log(`  TX ${i + 4}: ${result.success ? 'OK' : result.error} | ${amount} IOTAI`);
  }

  // 8. Final state
  console.log('\n=== Final State ===');
  console.log(`\nBalances:`);
  console.log(`  Agent Alpha: ${dag.getBalance(agent1.address)} IOTAI`);
  console.log(`  Agent Beta:  ${dag.getBalance(agent2.address)} IOTAI`);
  console.log(`  Agent Gamma: ${dag.getBalance(agent3.address)} IOTAI`);

  const stats = dag.getStats();
  console.log(`\nDAG Statistics:`);
  console.log(`  Total transactions: ${stats.totalTransactions}`);
  console.log(`  Active tips: ${stats.tipCount}`);
  console.log(`  Unique addresses: ${stats.uniqueAddresses}`);
  console.log(`  Used nonces: ${stats.usedNonces} (replay protection)`);

  // 9. Show DAG structure
  console.log(`\nDAG Structure (parent references):`);
  for (const [id, tx] of dag.transactions) {
    const parents = tx.parents.length > 0
      ? tx.parents.map(p => p.substring(0, 8)).join(' + ')
      : 'ROOT';
    console.log(`  ${id.substring(0, 10)}... [w:${tx.cumulativeWeight}] <- ${parents}`);
  }

  // 10. Show transaction history for an agent
  console.log(`\nAgent Alpha transaction history:`);
  const history = dag.getHistory(agent1.address);
  for (const tx of history) {
    const direction = tx.from === agent1.address ? 'SENT' : 'RECEIVED';
    console.log(`  ${direction} ${tx.amount} IOTAI | ${tx.to.substring(0, 20)}... | ${tx.metadata?.purpose || ''}`);
  }

  console.log('\n=== Demo complete! ===');
}

demo().catch(console.error);
