/**
 * IOTAI Decentralized Social Network
 *
 * Social layer built on the IOTAI DAG. All social data (profiles, posts,
 * comments, follows, forums, likes) is stored as data transactions with
 * the `_social` discriminator field, creating an immutable social graph.
 *
 * Data Model (stored as tx.metadata):
 *   - _social:profile  → User profile (username, bio, isAgent)
 *   - _social:post     → Text post, optionally in a forum
 *   - _social:comment  → Comment on a post
 *   - _social:follow   → Follow/unfollow relationship
 *   - _social:forum    → Forum (name, description, creator)
 *   - _social:like     → Like toggle on a post
 */

export class Social {
  /**
   * @param {object} params
   * @param {import('../core/dag.js').DAG} params.dag
   */
  constructor({ dag }) {
    this.dag = dag;

    // In-memory indexes (rebuilt from DAG on startup)
    /** @type {Map<string, object>} address -> profile */
    this.profiles = new Map();
    /** @type {Map<string, string>} username -> address */
    this.usernames = new Map();
    /** @type {Map<string, object>} postId -> post */
    this.posts = new Map();
    /** @type {Map<string, object[]>} address -> posts[] */
    this.postsByAuthor = new Map();
    /** @type {Map<string, object[]>} forumId -> posts[] */
    this.postsByForum = new Map();
    /** @type {Map<string, object[]>} postId -> comments[] */
    this.comments = new Map();
    /** @type {Map<string, Set<string>>} address -> Set<address> (who you follow) */
    this.follows = new Map();
    /** @type {Map<string, Set<string>>} address -> Set<address> (who follows you) */
    this.followers = new Map();
    /** @type {Map<string, object>} forumId -> forum */
    this.forums = new Map();
    /** @type {Map<string, Set<string>>} postId -> Set<address> */
    this.likes = new Map();

    this._rebuildIndex();
  }

  // ============================================================
  // WRITE METHODS
  // ============================================================

  /**
   * Create a user profile
   * @returns {{ txId: string }}
   */
  createProfile(wallet, tips, { username, bio, isAgent }) {
    if (!username) throw new Error('Username is required');
    const u = username.toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(u)) {
      throw new Error('Username must be 3-30 chars, lowercase alphanumeric or underscore');
    }
    if (this.usernames.has(u)) throw new Error('Username already taken');
    if (this.profiles.has(wallet.address)) throw new Error('Profile already exists');

    const metadata = {
      _social: 'profile',
      username: u,
      bio: bio || '',
      isAgent: !!isAgent,
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexProfile(tx);
    return { txId: tx.id };
  }

  /**
   * Update profile bio
   * @returns {{ txId: string }}
   */
  updateProfile(wallet, tips, { bio }) {
    if (!this.profiles.has(wallet.address)) throw new Error('Profile not found');

    const metadata = {
      _social: 'profile_update',
      bio: bio || '',
      author: wallet.address,
      updatedAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexProfileUpdate(tx);
    return { txId: tx.id };
  }

  /**
   * Create a post
   * @returns {{ postId: string, txId: string }}
   */
  createPost(wallet, tips, { content, forumId }) {
    if (!content || content.length > 2000) {
      throw new Error('Content is required and must be at most 2000 characters');
    }
    if (forumId && !this.forums.has(forumId)) throw new Error('Forum not found');

    const postId = this._generateId();
    const metadata = {
      _social: 'post',
      postId,
      content,
      forumId: forumId || null,
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexPost(tx);
    return { postId, txId: tx.id };
  }

  /**
   * Create a comment on a post
   * @returns {{ commentId: string, txId: string }}
   */
  createComment(wallet, tips, { postId, content }) {
    if (!postId || !this.posts.has(postId)) throw new Error('Post not found');
    if (!content || content.length > 2000) {
      throw new Error('Content is required and must be at most 2000 characters');
    }

    const commentId = this._generateId();
    const metadata = {
      _social: 'comment',
      commentId,
      postId,
      content,
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexComment(tx);
    return { commentId, txId: tx.id };
  }

  /**
   * Follow a user
   * @returns {{ txId: string }}
   */
  follow(wallet, tips, { target }) {
    if (!target) throw new Error('Target address is required');
    if (target === wallet.address) throw new Error('Cannot follow yourself');
    const myFollows = this.follows.get(wallet.address);
    if (myFollows && myFollows.has(target)) throw new Error('Already following');

    const metadata = {
      _social: 'follow',
      target,
      action: 'follow',
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexFollow(tx);
    return { txId: tx.id };
  }

  /**
   * Unfollow a user
   * @returns {{ txId: string }}
   */
  unfollow(wallet, tips, { target }) {
    if (!target) throw new Error('Target address is required');
    const myFollows = this.follows.get(wallet.address);
    if (!myFollows || !myFollows.has(target)) throw new Error('Not following');

    const metadata = {
      _social: 'follow',
      target,
      action: 'unfollow',
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexFollow(tx);
    return { txId: tx.id };
  }

  /**
   * Create a forum
   * @returns {{ forumId: string, txId: string }}
   */
  createForum(wallet, tips, { name, description }) {
    if (!name) throw new Error('Forum name is required');

    const forumId = this._generateId();
    const metadata = {
      _social: 'forum',
      forumId,
      name,
      description: description || '',
      creator: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexForum(tx);
    return { forumId, txId: tx.id };
  }

  /**
   * Like or unlike a post (toggle)
   * @returns {{ txId: string, liked: boolean }}
   */
  likePost(wallet, tips, { postId }) {
    if (!postId || !this.posts.has(postId)) throw new Error('Post not found');

    const postLikes = this.likes.get(postId);
    const alreadyLiked = postLikes && postLikes.has(wallet.address);

    const metadata = {
      _social: 'like',
      postId,
      action: alreadyLiked ? 'unlike' : 'like',
      author: wallet.address,
      createdAt: Date.now(),
    };

    const tx = wallet.sendData(tips, metadata);
    const result = this.dag.addTransaction(tx);
    if (!result.success) throw new Error(result.error);

    this._indexLike(tx);
    return { txId: tx.id, liked: !alreadyLiked };
  }

  // ============================================================
  // READ METHODS
  // ============================================================

  /** Get profile by address */
  getProfile(address) {
    return this.profiles.get(address) || null;
  }

  /** Get profile by username */
  getProfileByUsername(username) {
    const address = this.usernames.get(username?.toLowerCase());
    if (!address) return null;
    return this.profiles.get(address) || null;
  }

  /** Get a post with comment and like counts */
  getPost(postId) {
    const post = this.posts.get(postId);
    if (!post) return null;
    return this._enrichPost(post);
  }

  /** Get feed of posts from followed users, newest first */
  getFeed(address, { limit = 20, offset = 0 } = {}) {
    const following = this.follows.get(address);
    if (!following || following.size === 0) return { posts: [] };

    const posts = [];
    for (const target of following) {
      const authorPosts = this.postsByAuthor.get(target) || [];
      for (const p of authorPosts) {
        if (!p.forumId) posts.push(p);
      }
    }

    posts.sort((a, b) => b.createdAt - a.createdAt);
    return { posts: posts.slice(offset, offset + limit).map(p => this._enrichPost(p)) };
  }

  /** Get global feed (all non-forum posts), newest first */
  getGlobalFeed({ limit = 20, offset = 0 } = {}) {
    const posts = [...this.posts.values()]
      .filter(p => !p.forumId)
      .sort((a, b) => b.createdAt - a.createdAt);

    return { posts: posts.slice(offset, offset + limit).map(p => this._enrichPost(p)) };
  }

  /** Get comments for a post with author profiles */
  getComments(postId) {
    return (this.comments.get(postId) || [])
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(c => ({ ...c, authorProfile: this.profiles.get(c.author) || null }));
  }

  /** Get followers of an address with profile info */
  getFollowers(address) {
    const set = this.followers.get(address);
    if (!set) return [];
    return [...set].map(addr => ({
      address: addr,
      profile: this.profiles.get(addr) || null,
    }));
  }

  /** Get users an address is following with profile info */
  getFollowing(address) {
    const set = this.follows.get(address);
    if (!set) return [];
    return [...set].map(addr => ({
      address: addr,
      profile: this.profiles.get(addr) || null,
    }));
  }

  /** List all forums with post counts */
  getForums() {
    return [...this.forums.values()].map(f => ({
      ...f,
      postCount: (this.postsByForum.get(f.forumId) || []).length,
    }));
  }

  /** Get posts in a forum, newest first */
  getForumPosts(forumId, { limit = 20, offset = 0 } = {}) {
    const posts = (this.postsByForum.get(forumId) || [])
      .sort((a, b) => b.createdAt - a.createdAt);

    return { posts: posts.slice(offset, offset + limit).map(p => this._enrichPost(p)) };
  }

  /** Get posts by a specific user, newest first */
  getUserPosts(address, { limit = 20, offset = 0 } = {}) {
    const posts = (this.postsByAuthor.get(address) || [])
      .sort((a, b) => b.createdAt - a.createdAt);

    return { posts: posts.slice(offset, offset + limit).map(p => this._enrichPost(p)) };
  }

  /** Get social network stats */
  getStats() {
    let totalComments = 0;
    for (const list of this.comments.values()) totalComments += list.length;

    return {
      totalProfiles: this.profiles.size,
      totalPosts: this.posts.size,
      totalForums: this.forums.size,
      totalComments,
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /** Enrich a post with author profile, comment count, like count, forum name */
  _enrichPost(post) {
    const forum = post.forumId ? this.forums.get(post.forumId) : null;
    return {
      ...post,
      authorProfile: this.profiles.get(post.author) || null,
      commentCount: (this.comments.get(post.postId) || []).length,
      likeCount: (this.likes.get(post.postId) || new Set()).size,
      forumName: forum?.name || null,
    };
  }

  // ============================================================
  // INDEXING
  // ============================================================

  _rebuildIndex() {
    this.profiles.clear();
    this.usernames.clear();
    this.posts.clear();
    this.postsByAuthor.clear();
    this.postsByForum.clear();
    this.comments.clear();
    this.follows.clear();
    this.followers.clear();
    this.forums.clear();
    this.likes.clear();

    const txs = [...this.dag.transactions.values()]
      .filter(tx => tx.metadata?._social)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const tx of txs) {
      switch (tx.metadata._social) {
        case 'profile': this._indexProfile(tx); break;
        case 'profile_update': this._indexProfileUpdate(tx); break;
        case 'post': this._indexPost(tx); break;
        case 'comment': this._indexComment(tx); break;
        case 'follow': this._indexFollow(tx); break;
        case 'forum': this._indexForum(tx); break;
        case 'like': this._indexLike(tx); break;
      }
    }

    const stats = this.getStats();
    if (stats.totalProfiles > 0) {
      console.log(`[Social] Indexed ${stats.totalProfiles} profiles, ${stats.totalPosts} posts`);
    }
  }

  _indexProfile(tx) {
    const m = tx.metadata;
    const addr = m.author || tx.from;
    const profile = {
      address: addr,
      username: m.username,
      bio: m.bio || '',
      isAgent: !!m.isAgent,
      createdAt: m.createdAt || tx.timestamp,
    };
    this.profiles.set(addr, profile);
    this.usernames.set(m.username, addr);
  }

  _indexProfileUpdate(tx) {
    const m = tx.metadata;
    const addr = m.author || tx.from;
    const profile = this.profiles.get(addr);
    if (!profile) return;
    if (m.bio !== undefined) profile.bio = m.bio;
    profile.updatedAt = m.updatedAt || tx.timestamp;
  }

  _indexPost(tx) {
    const m = tx.metadata;
    const post = {
      postId: m.postId,
      txId: tx.id,
      content: m.content,
      forumId: m.forumId || null,
      author: m.author || tx.from,
      createdAt: m.createdAt || tx.timestamp,
    };
    this.posts.set(m.postId, post);

    const authorPosts = this.postsByAuthor.get(post.author) || [];
    authorPosts.push(post);
    this.postsByAuthor.set(post.author, authorPosts);

    if (post.forumId) {
      const forumPosts = this.postsByForum.get(post.forumId) || [];
      forumPosts.push(post);
      this.postsByForum.set(post.forumId, forumPosts);
    }
  }

  _indexComment(tx) {
    const m = tx.metadata;
    const comment = {
      commentId: m.commentId,
      txId: tx.id,
      postId: m.postId,
      content: m.content,
      author: m.author || tx.from,
      createdAt: m.createdAt || tx.timestamp,
    };
    const list = this.comments.get(m.postId) || [];
    list.push(comment);
    this.comments.set(m.postId, list);
  }

  _indexFollow(tx) {
    const m = tx.metadata;
    const addr = m.author || tx.from;

    if (m.action === 'follow') {
      if (!this.follows.has(addr)) this.follows.set(addr, new Set());
      this.follows.get(addr).add(m.target);

      if (!this.followers.has(m.target)) this.followers.set(m.target, new Set());
      this.followers.get(m.target).add(addr);
    } else if (m.action === 'unfollow') {
      this.follows.get(addr)?.delete(m.target);
      this.followers.get(m.target)?.delete(addr);
    }
  }

  _indexForum(tx) {
    const m = tx.metadata;
    this.forums.set(m.forumId, {
      forumId: m.forumId,
      txId: tx.id,
      name: m.name,
      description: m.description || '',
      creator: m.creator || tx.from,
      createdAt: m.createdAt || tx.timestamp,
    });
  }

  _indexLike(tx) {
    const m = tx.metadata;
    const addr = m.author || tx.from;
    if (!this.likes.has(m.postId)) this.likes.set(m.postId, new Set());

    if (m.action === 'like') {
      this.likes.get(m.postId).add(addr);
    } else {
      this.likes.get(m.postId).delete(addr);
    }
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}
