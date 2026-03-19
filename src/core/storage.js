/**
 * IOTAI Persistent Storage
 *
 * Saves DAG state to disk (fast cache) AND to GitHub (permanent backup).
 * On startup, loads from disk first; if empty, fetches from GitHub.
 * This ensures data survives Render redeploys (which wipe the filesystem).
 *
 * Required env var for persistence across deploys:
 *   GITHUB_TOKEN - Personal Access Token with 'repo' scope
 *   GITHUB_REPO  - e.g. "JOSEFON31/IOTAI" (defaults to this)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');
const STATE_FILE = 'iotai-state.json';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'JOSEFON31/IOTAI';
const GITHUB_BRANCH = 'data';
const GITHUB_PATH = 'state.json';

export class Storage {
  /**
   * @param {object} params
   * @param {import('./dag.js').DAG} params.dag
   * @param {import('./faucet.js').Faucet} params.faucet
   * @param {number} [params.autoSaveInterval=30000]
   */
  constructor({ dag, faucet, autoSaveInterval = 30000 }) {
    this.dag = dag;
    this.faucet = faucet;
    this.autoSaveInterval = autoSaveInterval;
    this.timer = null;
    this.saveCount = 0;
    this.lastGithubSave = 0;
    this.githubSha = null; // SHA of the file on GitHub (needed for updates)
    this.githubEnabled = !!GITHUB_TOKEN;
    this.saving = false;
    this.githubSaving = false; // lock for GitHub saves

    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  start() {
    this.timer = setInterval(() => this.save(), this.autoSaveInterval);

    const shutdown = () => {
      this.save({ forceGithub: true });
      setTimeout(() => process.exit(0), 2000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`[Storage] Auto-save every ${this.autoSaveInterval / 1000}s`);
    if (this.githubEnabled) {
      console.log(`[Storage] GitHub backup enabled: ${GITHUB_REPO}@${GITHUB_BRANCH}`);
    } else {
      console.log('[Storage] WARNING: No GITHUB_TOKEN set. Data will be lost on redeploy!');
      console.log('[Storage] Set GITHUB_TOKEN env var in Render for persistent storage.');
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ==================== SERIALIZE STATE ====================

  _serializeState() {
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      transactions: Array.from(this.dag.transactions.values()),
      balances: Object.fromEntries(this.dag.balances),
      nonces: Array.from(this.dag.usedNonces),
      faucet: this.faucet.exportState(),
    };
  }

  _restoreState(state) {
    if (!state || !state.transactions || state.transactions.length === 0) return false;

    const genesis = state.transactions.find(tx => tx.type === 'genesis');
    if (!genesis) return false;

    // Restore genesis
    this.dag.transactions.set(genesis.id, genesis);
    this.dag.children.set(genesis.id, new Set());
    this.dag.genesisId = genesis.id;
    this.dag.tips.add(genesis.id);

    // Restore transactions in order
    const remaining = state.transactions
      .filter(tx => tx.type !== 'genesis')
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of remaining) {
      this.dag.transactions.set(tx.id, tx);
      this.dag.children.set(tx.id, new Set());
      for (const parentId of tx.parents) {
        this.dag.children.get(parentId)?.add(tx.id);
        this.dag.tips.delete(parentId);
      }
      this.dag.tips.add(tx.id);
      if (tx.nonce) this.dag.usedNonces.add(tx.nonce);
    }

    // Restore balances
    if (state.balances) {
      this.dag.balances = new Map(Object.entries(state.balances).map(([k, v]) => [k, Number(v)]));
    }

    // Restore nonces
    if (state.nonces) {
      this.dag.usedNonces = new Set(state.nonces);
    }

    // Restore faucet
    if (state.faucet) {
      this.faucet.importState(state.faucet);
    }

    return true;
  }

  // ==================== DISK STORAGE (fast cache) ====================

  _saveToDisk(state) {
    try {
      writeFileSync(resolve(DATA_DIR, STATE_FILE), JSON.stringify(state), 'utf-8');
    } catch (err) {
      console.error('[Storage] Disk save error:', err.message);
    }
  }

  _loadFromDisk() {
    try {
      const path = resolve(DATA_DIR, STATE_FILE);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  // ==================== GITHUB STORAGE (permanent) ====================

  async _ensureDataBranch() {
    if (!this.githubEnabled) return;

    try {
      // Check if branch exists
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/branches/${GITHUB_BRANCH}`,
        { headers: this._githubHeaders() }
      );

      if (res.status === 404) {
        // Create branch from main
        const mainRes = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/main`,
          { headers: this._githubHeaders() }
        );
        const mainData = await mainRes.json();
        const sha = mainData.object?.sha;

        if (sha) {
          await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/git/refs`,
            {
              method: 'POST',
              headers: this._githubHeaders(),
              body: JSON.stringify({ ref: `refs/heads/${GITHUB_BRANCH}`, sha }),
            }
          );
          console.log(`[Storage] Created '${GITHUB_BRANCH}' branch on GitHub`);
        }
      }
    } catch (err) {
      console.error('[Storage] GitHub branch check error:', err.message);
    }
  }

  async _saveToGithub(state) {
    if (!this.githubEnabled || this.githubSaving) return;
    this.githubSaving = true;

    try {
      // Always fetch fresh SHA before saving to avoid conflicts
      await this._fetchGithubSha();

      const content = Buffer.from(JSON.stringify(state)).toString('base64');
      const body = {
        message: `[auto] Save state: ${state.transactions.length} txs, ${new Date().toISOString()}`,
        content,
        branch: GITHUB_BRANCH,
      };

      if (this.githubSha) {
        body.sha = this.githubSha;
      }

      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`,
        {
          method: 'PUT',
          headers: this._githubHeaders(),
          body: JSON.stringify(body),
        }
      );

      if (res.ok) {
        const data = await res.json();
        this.githubSha = data.content?.sha;
        this.lastGithubSave = Date.now();
        console.log(`[Storage] GitHub save OK (${state.transactions.length} txs)`);
      } else {
        const errText = await res.text();
        if (res.status === 409 || res.status === 422) {
          console.log('[Storage] GitHub SHA conflict, will retry next cycle');
        } else {
          console.error(`[Storage] GitHub save error ${res.status}: ${errText.substring(0, 200)}`);
        }
      }
    } catch (err) {
      console.error('[Storage] GitHub save error:', err.message);
    } finally {
      this.githubSaving = false;
    }
  }

  async _loadFromGithub() {
    if (!this.githubEnabled) return null;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`,
        { headers: this._githubHeaders() }
      );

      if (!res.ok) {
        console.log(`[Storage] No GitHub state found (${res.status})`);
        return null;
      }

      const data = await res.json();
      this.githubSha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const state = JSON.parse(content);
      console.log(`[Storage] Loaded from GitHub: ${state.transactions?.length || 0} txs`);
      return state;
    } catch (err) {
      console.error('[Storage] GitHub load error:', err.message);
      return null;
    }
  }

  async _fetchGithubSha() {
    if (!this.githubEnabled) return;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`,
        { headers: this._githubHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        this.githubSha = data.sha;
      }
    } catch {}
  }

  _githubHeaders() {
    return {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'IOTAI-Node',
    };
  }

  // ==================== PUBLIC API ====================

  /**
   * Save state to disk (always) and GitHub (every 60s or on force)
   */
  save({ forceGithub = false } = {}) {
    if (this.saving) return;
    this.saving = true;

    try {
      const state = this._serializeState();

      // Always save to disk (fast)
      this._saveToDisk(state);
      this.saveCount++;

      // Save to GitHub every 30s (to avoid rate limits) or when forced
      const timeSinceGithub = Date.now() - this.lastGithubSave;
      if (this.githubEnabled && (forceGithub || timeSinceGithub > 30000)) {
        this._saveToGithub(state).catch(err =>
          console.error('[Storage] GitHub async save error:', err.message)
        );
      }

      if (this.saveCount % 10 === 0) {
        console.log(`[Storage] Saved #${this.saveCount}: ${state.transactions.length} txs, ${Object.keys(state.balances).length} addrs`);
      }
    } catch (err) {
      console.error('[Storage] Save error:', err.message);
    } finally {
      this.saving = false;
    }
  }

  /**
   * Load state: try disk first, then GitHub
   * @returns {boolean}
   */
  async load() {
    console.log(`[Storage] Loading... GitHub enabled: ${this.githubEnabled}, token length: ${GITHUB_TOKEN.length}`);

    // 1. Try disk (fast, available within same deploy)
    const diskState = this._loadFromDisk();
    if (diskState && diskState.transactions?.length > 0) {
      const ok = this._restoreState(diskState);
      if (ok) {
        console.log(`[Storage] Restored from disk: ${diskState.transactions.length} txs, ${Object.keys(diskState.balances || {}).length} addrs`);
        if (this.githubEnabled) this._fetchGithubSha().catch(() => {});
        return true;
      }
    }

    // 2. Try GitHub (permanent, survives redeploy)
    if (this.githubEnabled) {
      console.log('[Storage] Disk empty, trying GitHub...');
      await this._ensureDataBranch();
      const githubState = await this._loadFromGithub();
      if (githubState && githubState.transactions?.length > 0) {
        const ok = this._restoreState(githubState);
        if (ok) {
          console.log(`[Storage] Restored from GitHub: ${githubState.transactions.length} txs`);
          this._saveToDisk(githubState);
          return true;
        }
      }
    } else {
      console.log('[Storage] WARNING: GITHUB_TOKEN not set! Data WILL be lost on redeploy.');
    }

    return false;
  }

  getStats() {
    return {
      saveCount: this.saveCount,
      githubEnabled: this.githubEnabled,
      lastGithubSave: this.lastGithubSave ? new Date(this.lastGithubSave).toISOString() : null,
      autoSaveInterval: this.autoSaveInterval,
    };
  }
}
