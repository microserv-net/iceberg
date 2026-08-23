/* ICEBERG — GitHub API client.
 *
 * One rule enforced in code: the token goes to api.github.com and nowhere else,
 * as an Authorization header, never in a URL. Every request asserts the origin
 * before it is sent.
 */

import { retry, sleep, Emitter } from './util.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status, body, response, permission } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
    this.response = response;
    this.permission = permission;
  }
}

export const events = new Emitter();

export class GitHub {
  #token = null;
  #etags = new Map();
  rate = { remaining: null, limit: null, reset: null, resource: 'core' };
  calls = 0;

  setToken(t) { this.#token = t || null; }
  get hasToken() { return !!this.#token; }

  /* ---- the single egress point ---- */
  async request(path, opts = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const target = new URL(url);
    if (target.origin !== API) {
      throw new GitHubError(`Refusing to send credentials to ${target.origin}`, { status: 0 });
    }

    const headers = {
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    // Conditional requests are OPT-IN. They must be, because a 304 carries no
    // body: a caller that is not expecting one reads `data` as null and
    // concludes the resource does not exist. getRef doing that turns a healthy
    // branch into "no branch", which turns the next commit into a root commit,
    // which GitHub rejects as a non-fast-forward — forever.
    // Only callers that handle `notModified` themselves pass an etagKey.
    const cacheKey = typeof opts.etagKey === 'string' ? opts.etagKey : null;
    if (cacheKey && this.#etags.has(cacheKey)) headers['If-None-Match'] = this.#etags.get(cacheKey);

    return retry(async () => {
      this.calls++;
      let res;
      try {
        res = await fetch(url, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: opts.signal,
        });
      } catch (netErr) {
        const e = new GitHubError('Cannot reach GitHub. Check your connection.', { status: 0 });
        e.offline = true;
        throw e;
      }

      this.#absorbRate(res);

      if (res.status === 304) {
        if (!cacheKey) {
          // Should be unreachable: we only send If-None-Match when asked to.
          // If a proxy manufactures one anyway, retry unconditionally rather
          // than hand the caller an empty body it will misread.
          this.#etags.delete(url);
          throw new GitHubError('Unexpected 304 from GitHub; retrying without cache.', { status: 304 });
        }
        return { notModified: true, status: 304, data: null };
      }

      const etag = res.headers.get('etag');
      if (cacheKey && etag && res.ok) this.#etags.set(cacheKey, etag);

      if (res.status === 204 || res.status === 202) return { status: res.status, data: null, res };

      const text = await res.text();
      let data = null;
      if (text) {
        if ((res.headers.get('content-type') || '').includes('json')) {
          try { data = JSON.parse(text); } catch { data = text; }
        } else data = text;
      }

      if (res.ok) return { status: res.status, data, res };

      throw this.#error(res, data);
    }, {
      tries: opts.tries ?? 4,
      onRetry: (err, n, wait) => events.emit('retry', { path, err, n, wait }),
    });
  }

  #absorbRate(res) {
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem != null) {
      this.rate = {
        remaining: Number(rem),
        limit: Number(res.headers.get('x-ratelimit-limit')),
        reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
        resource: res.headers.get('x-ratelimit-resource') || 'core',
      };
      events.emit('rate', this.rate);
    }
  }

  #error(res, data) {
    const msg = (data && (data.message || data.error)) || res.statusText || 'GitHub request failed';
    const err = new GitHubError(msg, { status: res.status, body: data, response: res });

    if (res.status === 401) {
      err.fatal = true;
      err.auth = true;
      err.message = 'GitHub rejected the key. It may have expired or been revoked.';
    } else if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        err.retryAfterMs = Math.min(retryAfter * 1000, 60_000);
        err.message = `GitHub asked us to slow down (${retryAfter}s).`;
        err.secondary = true;
      } else if (remaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        err.fatal = true;
        err.rateLimited = true;
        err.resetAt = reset;
        err.message = `GitHub API budget exhausted. It refills at ${new Date(reset).toLocaleTimeString()}.`;
      } else {
        err.fatal = true;
        err.permission = res.headers.get('x-accepted-github-permissions') || null;
        if (err.permission) {
          err.message = `The key is missing a permission: ${err.permission}`;
        }
      }
    } else if (res.status === 404) {
      err.fatal = true;
      err.notFound = true;
    } else if (res.status >= 400 && res.status < 500) {
      // 409/422 are conflicts, not transport failures. Blind retries cannot fix
      // them and turn one honest error into a burst of identical ones; the
      // caller re-reads state and rebuilds instead.
      err.fatal = true;
      if (res.status === 409 || res.status === 422) err.conflict = true;
    }
    return err;
  }

  /* ---- convenience ---- */
  get(path, opts)        { return this.request(path, opts).then((r) => r.data); }
  post(path, body, opts) { return this.request(path, { ...opts, method: 'POST', body }).then((r) => r.data); }
  patch(path, body, opts){ return this.request(path, { ...opts, method: 'PATCH', body }).then((r) => r.data); }
  put(path, body, opts)  { return this.request(path, { ...opts, method: 'PUT', body }).then((r) => r.data); }
  del(path, opts)        { return this.request(path, { ...opts, method: 'DELETE' }).then((r) => r.data); }

  async maybe(path, opts) {
    try { return await this.get(path, opts); }
    catch (e) { if (e.notFound) return null; throw e; }
  }

  /* ---- identity ---- */
  async viewer() {
    const u = await this.get('/user');
    return { login: u.login, id: u.id, name: u.name, avatar: u.avatar_url, plan: u.plan?.name ?? null };
  }

  /* ---- git data ---- */

  /** Create a blob from raw bytes. Returns its sha. */
  async putBlob(owner, repo, base64) {
    const r = await this.post(`/repos/${owner}/${repo}/git/blobs`, { content: base64, encoding: 'base64' });
    return r.sha;
  }

  /** Read a blob's raw bytes. Uses the raw media type; api.github.com is CORS-clean. */
  async getBlobRaw(owner, repo, sha, signal) {
    const r = await this.request(`/repos/${owner}/${repo}/git/blobs/${sha}`, {
      accept: 'application/vnd.github.raw', signal,
    });
    // Raw media type on a blob returns the bytes as a string of code units.
    if (typeof r.data === 'string') {
      const out = new Uint8Array(r.data.length);
      for (let i = 0; i < r.data.length; i++) out[i] = r.data.charCodeAt(i) & 0xff;
      return out;
    }
    throw new GitHubError('Unexpected blob payload', { status: r.status });
  }

  async getRef(owner, repo, ref) {
    return this.maybe(`/repos/${owner}/${repo}/git/ref/${ref}`, { etagKey: null });
  }

  async getCommit(owner, repo, sha) {
    return this.get(`/repos/${owner}/${repo}/git/commits/${sha}`);
  }

  async getTree(owner, repo, sha, recursive = false) {
    return this.get(`/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
  }

  async createTree(owner, repo, entries, baseTree) {
    return this.post(`/repos/${owner}/${repo}/git/trees`, {
      tree: entries, ...(baseTree ? { base_tree: baseTree } : {}),
    });
  }

  async createCommit(owner, repo, { message, tree, parents }) {
    return this.post(`/repos/${owner}/${repo}/git/commits`, { message, tree, parents });
  }

  /** Compare-and-swap ref update. force stays false so concurrent devices lose
   *  loudly instead of silently overwriting each other. */
  async updateRef(owner, repo, ref, sha, force = false) {
    return this.patch(`/repos/${owner}/${repo}/git/refs/${ref}`, { sha, force });
  }

  async createRef(owner, repo, ref, sha) {
    return this.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/${ref}`, sha });
  }

  /* ---- contents (single small files only) ---- */
  async getContentRaw(owner, repo, path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request(`/repos/${owner}/${repo}/contents/${path}${q}`, {
      accept: 'application/vnd.github.raw',
      etagKey: `${owner}/${repo}/${path}@${ref ?? ''}`,
    });
  }

  /* ---- pacing ---- */

  /** Called before a burst of writes. Refuses to start something it cannot finish. */
  async budget(need, label) {
    if (this.rate.remaining == null) await this.get('/rate_limit').catch(() => {});
    const remaining = this.rate.remaining ?? 5000;
    if (remaining < need + 100) {
      const err = new GitHubError(
        `${label} needs about ${need} GitHub API calls and only ${remaining} remain ` +
        `before ${new Date(this.rate.reset).toLocaleTimeString()}.`,
        { status: 0 }
      );
      err.fatal = true;
      err.budget = { need, remaining, reset: this.rate.reset };
      throw err;
    }
    return remaining;
  }

  /** Cooperative slow-down when the budget thins during a long calve. */
  async breathe() {
    const r = this.rate.remaining;
    if (r == null) return;
    if (r < 200) await sleep(1500);
    else if (r < 600) await sleep(400);
  }
}

export const gh = new GitHub();
