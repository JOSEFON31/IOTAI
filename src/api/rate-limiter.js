/**
 * IOTAI Rate Limiter + API Key System
 *
 * Protects the API from abuse with per-IP and per-key rate limiting.
 * API keys get higher limits and are required for write operations in production.
 *
 * Rate limits:
 *   - Anonymous: 30 req/min (read), 10 req/min (write)
 *   - API key (free tier): 120 req/min (read), 60 req/min (write)
 *   - API key (pro tier): 600 req/min (read), 300 req/min (write)
 */

export class RateLimiter {
  constructor({ dag } = {}) {
    this.dag = dag;

    /** @type {Map<string, RateWindow>} ip/key -> window */
    this.windows = new Map();

    /** @type {Map<string, ApiKey>} key -> info */
    this.apiKeys = new Map();

    this.tiers = {
      anonymous: { readLimit: 30, writeLimit: 10, windowMs: 60000 },
      free:      { readLimit: 120, writeLimit: 60, windowMs: 60000 },
      pro:       { readLimit: 600, writeLimit: 300, windowMs: 60000 },
    };

    // Cleanup old windows every 5 minutes
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  // ============================================================
  // API KEY MANAGEMENT
  // ============================================================

  /** Generate a new API key */
  createApiKey({ name, tier, owner }) {
    const key = 'iotai_' + this._randomHex(32);
    const apiKey = {
      key,
      name: name || 'Unnamed Key',
      tier: tier || 'free',
      owner: owner || 'unknown',
      createdAt: Date.now(),
      lastUsed: null,
      totalRequests: 0,
      status: 'active',
    };
    this.apiKeys.set(key, apiKey);
    return apiKey;
  }

  /** Revoke an API key */
  revokeKey(key) {
    const apiKey = this.apiKeys.get(key);
    if (!apiKey) return false;
    apiKey.status = 'revoked';
    return true;
  }

  /** Get API key info (masked) */
  getKeyInfo(key) {
    const apiKey = this.apiKeys.get(key);
    if (!apiKey) return null;
    return {
      key: key.substring(0, 10) + '...' + key.substring(key.length - 4),
      name: apiKey.name,
      tier: apiKey.tier,
      owner: apiKey.owner,
      status: apiKey.status,
      totalRequests: apiKey.totalRequests,
      lastUsed: apiKey.lastUsed,
      createdAt: apiKey.createdAt,
    };
  }

  /** List all API keys (masked) */
  listKeys() {
    return [...this.apiKeys.values()].map(k => ({
      key: k.key.substring(0, 10) + '...' + k.key.substring(k.key.length - 4),
      name: k.name,
      tier: k.tier,
      status: k.status,
      totalRequests: k.totalRequests,
      lastUsed: k.lastUsed,
    }));
  }

  // ============================================================
  // RATE LIMITING
  // ============================================================

  /**
   * Check if request should be allowed
   * @param {object} params
   * @param {string} params.ip - Client IP
   * @param {string} [params.apiKey] - API key (from X-API-Key header)
   * @param {boolean} [params.isWrite] - Is this a write operation (POST/PUT/DELETE)?
   * @returns {{ allowed: boolean, remaining: number, resetAt: number, tier: string, error?: string }}
   */
  check({ ip, apiKey, isWrite = false }) {
    let tier = 'anonymous';
    let identifier = ip;

    // Validate API key if provided
    if (apiKey) {
      const keyInfo = this.apiKeys.get(apiKey);
      if (!keyInfo) {
        return { allowed: false, remaining: 0, resetAt: 0, tier: 'invalid', error: 'Invalid API key' };
      }
      if (keyInfo.status !== 'active') {
        return { allowed: false, remaining: 0, resetAt: 0, tier: keyInfo.tier, error: 'API key revoked' };
      }
      tier = keyInfo.tier;
      identifier = apiKey;
      keyInfo.lastUsed = Date.now();
      keyInfo.totalRequests++;
    }

    const limits = this.tiers[tier] || this.tiers.anonymous;
    const limit = isWrite ? limits.writeLimit : limits.readLimit;
    const windowKey = `${identifier}:${isWrite ? 'w' : 'r'}`;

    // Get or create window
    let window = this.windows.get(windowKey);
    const now = Date.now();

    if (!window || now > window.resetAt) {
      window = { count: 0, resetAt: now + limits.windowMs };
      this.windows.set(windowKey, window);
    }

    window.count++;

    if (window.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: window.resetAt,
        tier,
        error: `Rate limit exceeded. ${limit} requests per ${limits.windowMs / 1000}s for ${tier} tier.`,
      };
    }

    return {
      allowed: true,
      remaining: limit - window.count,
      resetAt: window.resetAt,
      tier,
    };
  }

  /**
   * Get rate limit headers for response
   */
  getHeaders(result) {
    return {
      'X-RateLimit-Limit': String(result.allowed ? result.remaining + 1 : 0),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
      'X-RateLimit-Tier': result.tier,
    };
  }

  /** Get rate limiter stats */
  getStats() {
    return {
      activeWindows: this.windows.size,
      totalApiKeys: this.apiKeys.size,
      activeApiKeys: [...this.apiKeys.values()].filter(k => k.status === 'active').length,
      tiers: this.tiers,
    };
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  _cleanup() {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now > window.resetAt + 60000) { // 1 min grace
        this.windows.delete(key);
      }
    }
  }

  _randomHex(length) {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * 16)];
    }
    return result;
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}
