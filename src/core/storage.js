/**
 * IOTAI Persistent Storage
 *
 * Saves DAG state, balances, and faucet data to disk as JSON files.
 * Auto-saves periodically and on shutdown.
 * Auto-loads on startup if data exists.
 *
 * Storage files:
 *   data/dag.json      - All transactions
 *   data/balances.json  - Address balances
 *   data/faucet.json    - Face hashes, claimed addresses, distribution stats
 *   data/nonces.json    - Used nonces (replay protection)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');

export class Storage {
  /**
   * @param {object} params
   * @param {import('./dag.js').DAG} params.dag
   * @param {import('./faucet.js').Faucet} params.faucet
   * @param {number} [params.autoSaveInterval=30000] - ms between auto-saves
   */
  constructor({ dag, faucet, autoSaveInterval = 30000 }) {
    this.dag = dag;
    this.faucet = faucet;
    this.autoSaveInterval = autoSaveInterval;
    this.timer = null;
    this.saveCount = 0;

    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Start auto-save timer and register shutdown hooks
   */
  start() {
    // Auto-save periodically
    this.timer = setInterval(() => {
      this.save();
    }, this.autoSaveInterval);

    // Save on shutdown
    const shutdown = () => {
      this.save();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`[Storage] Auto-save every ${this.autoSaveInterval / 1000}s to ${DATA_DIR}`);
  }

  /**
   * Stop auto-save timer
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Save all state to disk
   */
  save() {
    try {
      // 1. Transactions
      const transactions = Array.from(this.dag.transactions.values());
      this._writeJSON('dag.json', transactions);

      // 2. Balances
      const balances = Object.fromEntries(this.dag.balances);
      this._writeJSON('balances.json', balances);

      // 3. Nonces
      const nonces = Array.from(this.dag.usedNonces);
      this._writeJSON('nonces.json', nonces);

      // 4. Faucet state
      const faucetState = this.faucet.exportState();
      this._writeJSON('faucet.json', faucetState);

      this.saveCount++;
      if (this.saveCount % 10 === 0) {
        console.log(`[Storage] Saved (${transactions.length} txs, ${Object.keys(balances).length} addresses, ${faucetState.totalRecipients} faucet claims)`);
      }
    } catch (err) {
      console.error('[Storage] Save error:', err.message);
    }
  }

  /**
   * Load all state from disk (call before starting the network)
   * @returns {boolean} true if data was loaded, false if starting fresh
   */
  load() {
    const dagPath = resolve(DATA_DIR, 'dag.json');
    if (!existsSync(dagPath)) {
      console.log('[Storage] No existing data found. Starting fresh.');
      return false;
    }

    try {
      // 1. Load transactions and rebuild DAG
      const transactions = this._readJSON('dag.json');
      if (!transactions || transactions.length === 0) {
        console.log('[Storage] Empty DAG file. Starting fresh.');
        return false;
      }

      // Find genesis
      const genesis = transactions.find(tx => tx.type === 'genesis');
      if (!genesis) {
        console.log('[Storage] No genesis found in saved data. Starting fresh.');
        return false;
      }

      // Set genesis
      this.dag.transactions.set(genesis.id, genesis);
      this.dag.children.set(genesis.id, new Set());
      this.dag.genesisId = genesis.id;
      this.dag.tips.add(genesis.id);

      // Add remaining transactions in timestamp order
      const remaining = transactions
        .filter(tx => tx.type !== 'genesis')
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const tx of remaining) {
        // Add directly without balance checks (we'll restore balances from file)
        this.dag.transactions.set(tx.id, tx);
        this.dag.children.set(tx.id, new Set());

        for (const parentId of tx.parents) {
          this.dag.children.get(parentId)?.add(tx.id);
          this.dag.tips.delete(parentId);
        }
        this.dag.tips.add(tx.id);

        if (tx.nonce) {
          this.dag.usedNonces.add(tx.nonce);
        }
      }

      // 2. Load balances (overwrite computed ones with saved state)
      const balances = this._readJSON('balances.json');
      if (balances) {
        this.dag.balances = new Map(Object.entries(balances).map(([k, v]) => [k, Number(v)]));
      }

      // 3. Load nonces
      const nonces = this._readJSON('nonces.json');
      if (nonces) {
        this.dag.usedNonces = new Set(nonces);
      }

      // 4. Load faucet state
      const faucetState = this._readJSON('faucet.json');
      if (faucetState) {
        this.faucet.importState(faucetState);
      }

      console.log(`[Storage] Loaded: ${this.dag.transactions.size} txs, ${this.dag.balances.size} addresses, ${this.faucet.totalRecipients} faucet claims`);
      return true;

    } catch (err) {
      console.error('[Storage] Load error:', err.message);
      console.log('[Storage] Starting fresh due to load error.');
      return false;
    }
  }

  /**
   * Get storage stats
   */
  getStats() {
    return {
      saveCount: this.saveCount,
      dataDir: DATA_DIR,
      autoSaveInterval: this.autoSaveInterval,
      files: ['dag.json', 'balances.json', 'nonces.json', 'faucet.json'].map(f => {
        const path = resolve(DATA_DIR, f);
        return { file: f, exists: existsSync(path) };
      }),
    };
  }

  // ---- Private ----

  _writeJSON(filename, data) {
    const path = resolve(DATA_DIR, filename);
    writeFileSync(path, JSON.stringify(data), 'utf-8');
  }

  _readJSON(filename) {
    const path = resolve(DATA_DIR, filename);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  }
}
