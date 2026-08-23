/* ICEBERG — the keel.
 *
 * The keel is a content-addressed store of filesystem pieces. A floe does
 * not contain a disk image; it contains an ordered list of chunk hashes. Two
 * floes that share a compiler share its chunks, byte for byte, and Git stores
 * each chunk exactly once because the path is the hash.
 *
 * Boundaries are content-defined (a Gear rolling hash), not fixed. Inserting a
 * file near the front of the stream shifts every later byte, and fixed-size
 * blocks would then differ all the way down. Content-defined boundaries
 * re-synchronise within roughly one chunk, so a small change costs a small
 * upload — which is the whole reason the vault does not double in size every
 * time you calve.
 *
 * Chunk sources, in order:
 *   1. the local cache        free
 *   2. the public base image  a plain CDN fetch, no token, shared by everyone
 *   3. the vault              one authenticated blob read
 */

import { KEEL, IMAGES } from './config.js';
import { gh } from './github.js';
import { idb, trimCache } from './idb.js';
import { repo } from './vault.js';
import {
  sha256, deflate, inflate, toBase64, pool, Emitter, bytesHuman,
} from './util.js';

export const keel = new Emitter();

/* The cutter lives in chunker.js so it can be tested on its own and kept in
 * lockstep with the Node image builder. Re-exported here because callers think
 * of cutting as part of the keel. */
export { GEAR, cut } from './chunker.js';

/* ---------------------------------------------------------------- */
/* chunk transport                                                   */
/* ---------------------------------------------------------------- */

const chunkPath = (hash) => `keel/${hash.slice(0, 2)}/${hash}`;

/** hash → git blob sha, for the current vault head. One recursive tree read. */
let blobMap = { head: null, map: null, truncated: false };

export async function resolveVaultBlobs({ force = false } = {}) {
  if (!force && blobMap.head === repo.head && blobMap.map) return blobMap.map;
  if (!repo.tree) return new Map();

  const tree = await gh.getTree(repo.owner, repo.name, repo.tree, true);
  const map = new Map();
  for (const e of tree.tree) {
    if (e.type === 'blob' && e.path.startsWith('keel/')) {
      map.set(e.path.slice(e.path.lastIndexOf('/') + 1), e.sha);
    }
  }
  blobMap = { head: repo.head, map, truncated: !!tree.truncated };
  if (tree.truncated) {
    // Very large vault. Fall back to per-prefix reads on demand rather than
    // pretending we have the whole picture.
    keel.emit('truncated', { count: map.size });
  }
  return map;
}

async function resolvePrefix(prefix) {
  // Used only when the recursive read truncated.
  const root = await gh.getTree(repo.owner, repo.name, repo.tree, false);
  const keelEntry = root.tree.find((e) => e.path === 'keel' && e.type === 'tree');
  if (!keelEntry) return new Map();
  const dirs = await gh.getTree(repo.owner, repo.name, keelEntry.sha, false);
  const sub = dirs.tree.find((e) => e.path === prefix);
  if (!sub) return new Map();
  const files = await gh.getTree(repo.owner, repo.name, sub.sha, false);
  const m = new Map();
  for (const e of files.tree) m.set(e.path, e.sha);
  return m;
}

/** Everything the vault already holds, from the floes that reference it. */
export function knownFromManifests(manifests) {
  const set = new Set();
  for (const m of manifests) {
    for (const h of m?.fs?.indexChunks ?? []) set.add(h);
    for (const c of m?.fs?.streamChunks ?? []) set.add(c.h ?? c);
    for (const h of m?.warm?.chunks ?? []) set.add(h);
  }
  return set;
}

/* ---- reading ---- */

const inflight = new Map();

export async function getChunk(hash, { imageId = null, signal } = {}) {
  const cached = await idb.get('cache', `c:${hash}`);
  if (cached) {
    const bytes = new Uint8Array(cached);
    if (await sha256(bytes) === hash) return bytes;
    await idb.del('cache', `c:${hash}`).catch(() => {});
  }

  if (inflight.has(hash)) return inflight.get(hash);

  const job = (async () => {
    let raw = null;
    let publicUrl = null;
    let publicError = null;

    // 2. public base image — no token, cacheable by the browser and the CDN
    if (imageId) {
      const url = `${IMAGES.baseUrl}${imageId}/${chunkPath(hash)}`;
      publicUrl = url;
      try {
        const res = await fetch(url, { signal, cache: 'force-cache' });
        if (res.ok) raw = new Uint8Array(await res.arrayBuffer());
        else publicError = `HTTP ${res.status}`;
      } catch (e) { publicError = e.message; }
    }

    const decode = async (stored) => {
      const bytes = KEEL.compress ? await inflate(stored) : stored;
      const actual = await sha256(bytes);
      if (actual !== hash) throw new Error(`decoded hash is ${actual.slice(0, 12)}…`);
      return bytes;
    };

    // A CDN can return a 200 HTML/LFS body for a missing or unpublished asset.
    // Reject it here so a vault copy can still satisfy the request.
    if (raw) {
      try {
        const bytes = await decode(raw);
        idb.set('cache', `c:${hash}`, bytes).catch(() => {});
        return bytes;
      } catch (e) {
        publicError = e.message;
        raw = null;
      }
    }

    // 3. the vault
    if (!raw) {
      let map = await resolveVaultBlobs();
      let sha = map.get(hash);
      if (!sha && blobMap.truncated) {
        const m2 = await resolvePrefix(hash.slice(0, 2));
        sha = m2.get(hash);
      }
      if (!sha) {
        // The index refers to a chunk nothing holds. Say so precisely; this is
        // the one failure that cannot be papered over.
        throw new Error(
          `A piece of this floe is missing from your vault (${hash.slice(0, 12)}…). ` +
          `The calve that wrote it may not have finished. Older floes are unaffected.`
        );
      }
      raw = await gh.getBlobRaw(repo.owner, repo.name, sha, signal);
    }

    let bytes;
    try {
      bytes = await decode(raw);
    } catch (e) {
      const where = publicUrl ? ` from ${publicUrl}` : '';
      const detail = publicError ? ` Public response: ${publicError}.` : '';
      throw new Error(
        `The chunk ${hash.slice(0, 12)}… is not valid ${KEEL.compress ? 'raw-DEFLATE' : 'binary'} data${where}.` +
        `${detail} The published image may be incomplete or served as an HTML/LFS response. ` +
        `Original error: ${e.message}`
      );
    }
    idb.set('cache', `c:${hash}`, bytes).catch(() => {});
    return bytes;
  })();

  inflight.set(hash, job);
  try { return await job; } finally { inflight.delete(hash); }
}

/** Fetch many chunks with bounded concurrency and real progress. */
export async function getChunks(hashes, opts = {}) {
  const out = new Map();
  await pool(hashes, KEEL.downloadConcurrency, async (h) => {
    out.set(h, await getChunk(h, opts));
  }, opts.onProgress);
  return out;
}

/* ---- writing ---- */

/**
 * Upload every chunk the vault does not already hold. Returns tree entries for
 * the caller's single commit, plus honest statistics.
 *
 * Nothing here touches a ref. If the upload dies halfway, the blobs are orphans
 * and GitHub collects them; no floe points at a partial write, so a failed
 * calve leaves the vault exactly as it was.
 */
export async function putChunks(chunks, getBytes, known, { onProgress, signal } = {}) {
  const missing = [];
  const seen = new Set();
  for (const c of chunks) {
    if (known.has(c.hash) || seen.has(c.hash)) continue;
    seen.add(c.hash);
    missing.push(c);
  }

  let uploaded = 0;
  let bytesOut = 0;
  const entries = [];

  await pool(missing, KEEL.uploadConcurrency, async (c) => {
    if (signal?.aborted) throw new Error('Calve cancelled.');
    const plain = await getBytes(c);
    const stored = KEEL.compress ? await deflate(plain) : plain;
    const b64 = toBase64(stored);
    bytesOut += b64.length;
    const sha = await gh.putBlob(repo.owner, repo.name, b64);
    entries.push({ path: chunkPath(c.hash), sha });
    idb.set('cache', `c:${c.hash}`, plain).catch(() => {});
    uploaded++;
    await gh.breathe();
  }, (done, total) => onProgress?.({ done, total, phase: 'upload' }));

  trimCache().catch(() => {});

  return {
    entries,
    uploaded,
    shared: chunks.length - missing.length,
    bytesOut,
    summary: `${uploaded} new ${uploaded === 1 ? 'piece' : 'pieces'} (${bytesHuman(bytesOut)}), ` +
             `${chunks.length - missing.length} already in your vault`,
  };
}

/** Blob shas we just wrote are usable immediately; keep the map warm. */
export function noteWritten(entries) {
  if (!blobMap.map) return;
  for (const e of entries) blobMap.map.set(e.path.slice(e.path.lastIndexOf('/') + 1), e.sha);
}
