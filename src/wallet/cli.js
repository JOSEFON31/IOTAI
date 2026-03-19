#!/usr/bin/env node
/**
 * IOTAI Wallet CLI
 *
 * Command-line interface for managing IOTAI wallets.
 *
 * Usage:
 *   node src/wallet/cli.js create              - Create new wallet with seed phrase
 *   node src/wallet/cli.js restore             - Restore wallet from seed phrase
 *   node src/wallet/cli.js balance             - Check wallet balance
 *   node src/wallet/cli.js send <to> <amount>  - Send IOTAI tokens
 *   node src/wallet/cli.js history             - Transaction history
 *   node src/wallet/cli.js info                - Show wallet info
 */

import { Wallet } from './wallet.js';
import { createInterface } from 'readline';

const API_URL = process.env.IOTAI_API || 'http://localhost:8080';

// ============================================================
// HELPERS
// ============================================================

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function api(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  const data = await res.json();
  if (!res.ok && data.error) {
    throw new Error(data.error);
  }
  return data;
}

async function authenticate(wallet) {
  // Use passphrase-based auth if available, otherwise create temp token
  const data = await api('POST', '/api/v1/auth/token', {
    passphrase: wallet._authPassphrase,
  });
  return data.token;
}

function printBox(title, lines) {
  const maxLen = Math.max(title.length + 4, ...lines.map(l => l.length + 4));
  const border = '─'.repeat(maxLen);
  console.log(`\n┌${border}┐`);
  console.log(`│  ${title.padEnd(maxLen - 2)}│`);
  console.log(`├${border}┤`);
  for (const line of lines) {
    console.log(`│  ${line.padEnd(maxLen - 2)}│`);
  }
  console.log(`└${border}┘`);
}

// ============================================================
// COMMANDS
// ============================================================

async function cmdCreate() {
  const wallet = Wallet.createWithSeedPhrase();

  printBox('New IOTAI Wallet', [
    `Address:     ${wallet.address}`,
    `Public Key:  ${wallet.getInfo().publicKey}`,
    '',
    'SEED PHRASE (write this down!):',
    `  ${wallet.mnemonic}`,
    '',
    'WARNING: If you lose your seed phrase,',
    'you lose access to your wallet forever.',
  ]);
}

async function cmdRestore() {
  const mnemonic = await prompt('Enter your 12-word seed phrase: ');

  try {
    const wallet = Wallet.fromMnemonic(mnemonic);
    printBox('Wallet Restored', [
      `Address:     ${wallet.address}`,
      `Public Key:  ${wallet.getInfo().publicKey}`,
    ]);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

async function cmdBalance() {
  const passphrase = await prompt('Passphrase or seed phrase: ');

  let wallet;
  const words = passphrase.split(/\s+/);
  if (words.length === 12) {
    wallet = Wallet.fromMnemonic(passphrase);
  } else {
    wallet = new Wallet({ passphrase });
  }

  try {
    const token = await getToken(passphrase);
    const data = await api('GET', '/api/v1/balance', null, token);
    printBox('Balance', [
      `Address:  ${data.address}`,
      `Balance:  ${data.balance.toLocaleString()} ${data.unit}`,
    ]);
  } catch (err) {
    // Fallback: show address even if API is unreachable
    if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch')) {
      printBox('Wallet (offline)', [
        `Address:  ${wallet.address}`,
        `Balance:  (node not reachable at ${API_URL})`,
      ]);
    } else {
      console.error(`\nError: ${err.message}`);
    }
    process.exit(1);
  }
}

async function cmdSend() {
  const to = args[1];
  const amount = parseFloat(args[2]);

  if (!to || !amount || isNaN(amount) || amount <= 0) {
    console.error('Usage: wallet send <recipient_address> <amount>');
    process.exit(1);
  }

  const passphrase = await prompt('Passphrase or seed phrase: ');

  try {
    const token = await getToken(passphrase);
    const data = await api('POST', '/api/v1/transfer', { to, amount }, token);

    printBox('Transaction Sent', [
      `TX ID:   ${data.txId}`,
      `From:    ${data.from}`,
      `To:      ${data.to}`,
      `Amount:  ${data.amount.toLocaleString()} IOTAI`,
      `Status:  ${data.status}`,
    ]);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

async function cmdHistory() {
  const passphrase = await prompt('Passphrase or seed phrase: ');

  try {
    const token = await getToken(passphrase);
    const data = await api('GET', '/api/v1/history', null, token);

    if (data.transactions.length === 0) {
      console.log(`\nNo transactions found for ${data.address}`);
      return;
    }

    console.log(`\nTransaction history for ${data.address}:`);
    console.log('─'.repeat(90));
    console.log(
      'Type'.padEnd(10) +
      'From'.padEnd(22) +
      'To'.padEnd(22) +
      'Amount'.padStart(14) +
      '  Confirmed'.padEnd(12) +
      'Date'
    );
    console.log('─'.repeat(90));

    for (const tx of data.transactions) {
      const date = new Date(tx.timestamp).toLocaleString();
      const from = tx.from.substring(0, 20);
      const to = tx.to.substring(0, 20);
      const confirmed = tx.confirmed ? 'yes' : 'no';
      console.log(
        tx.type.padEnd(10) +
        from.padEnd(22) +
        to.padEnd(22) +
        tx.amount.toLocaleString().padStart(14) +
        `  ${confirmed}`.padEnd(12) +
        date
      );
    }
    console.log('─'.repeat(90));
    console.log(`Total: ${data.transactions.length} transactions`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

async function cmdInfo() {
  const passphrase = await prompt('Passphrase or seed phrase: ');

  let wallet;
  const words = passphrase.split(/\s+/);
  if (words.length === 12) {
    wallet = Wallet.fromMnemonic(passphrase);
  } else {
    wallet = new Wallet({ passphrase });
  }

  const info = wallet.getInfo();
  printBox('Wallet Info', [
    `Address:          ${info.address}`,
    `Public Key:       ${info.publicKey}`,
    `HD Wallet:        ${info.hasHD ? 'yes' : 'no'}`,
    `Derivation Index: ${info.derivationIndex}`,
    `API Node:         ${API_URL}`,
  ]);
}

async function getToken(passphrase) {
  const data = await api('POST', '/api/v1/auth/token', { passphrase });
  return data.token;
}

// ============================================================
// MAIN
// ============================================================

const args = process.argv.slice(2);
const command = args[0];

const commands = {
  create: cmdCreate,
  restore: cmdRestore,
  balance: cmdBalance,
  send: cmdSend,
  history: cmdHistory,
  info: cmdInfo,
};

if (!command || !commands[command]) {
  console.log(`
  ██╗ ██████╗ ████████╗ █████╗ ██╗  Wallet CLI
  ██║██╔═══██╗╚══██╔══╝██╔══██╗██║
  ██║██║   ██║   ██║   ███████║██║
  ██║██║   ██║   ██║   ██╔══██║██║
  ██║╚██████╔╝   ██║   ██║  ██║██║
  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝

  Usage: node src/wallet/cli.js <command>

  Commands:
    create              Create a new wallet with seed phrase
    restore             Restore wallet from seed phrase
    balance             Check wallet balance
    send <to> <amount>  Send IOTAI to an address
    history             View transaction history
    info                Show wallet details

  Environment:
    IOTAI_API           API node URL (default: http://localhost:8080)

  Examples:
    node src/wallet/cli.js create
    node src/wallet/cli.js balance
    node src/wallet/cli.js send iotai_abc123... 500
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
