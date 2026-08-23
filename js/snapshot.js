/* ICEBERG — snapshots.
 *
 * A floe's filesystem is stored as one virtual byte stream: the contents of
 * every regular file, concatenated in path order, cut at content-defined
 * boundaries (see keel.js). The index says where each file sits in that
 * stream. Nothing is stored twice, in a floe or between floes.
 *
 *   index      { files: [ {p,m,u,g,t,s,h,off,l} ], stream: bytes, image }
 *   stream     file bytes, path-sorted, cut into chunks
 *
 * Path order is used rather than arrival order because it is stable: the same
 * machine captured twice produces the same stream, and a machine that gains one
 * package perturbs the stream only around that package.
 */

import { KEEL, LIMITS } from './config.js';
import { StreamCutter, cut } from './chunker.js';
import {
  sha256, hex, concatBytes, enc, dec, deflate, inflate, isExcluded, normPath,
} from './util.js';

export const S_IFMT   = 0o170000;
export const S_IFDIR  = 0o040000;
export const S_IFREG  = 0o100000;
export const S_IFLNK  = 0o120000;

/* ---------------------------------------------------------------- */
/* capture                                                           */
/* ---------------------------------------------------------------- */

/**
 * Walk a filesystem adapter and produce { index, chunks }.
 * onChunk is awaited for every chunk in stream order, which is where the
 * caller uploads it and then lets it go.
 */
export async function capture(fs, { onChunk, onProgress, signal } = {}) {
  const entries = await fs.walk();
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files = [];
  const cutter = new StreamCutter(onChunk ?? (async () => {}), sha256);
  let scanned = 0;
  let totalBytes = 0;

  for (const e of entries) {
    if (signal?.aborted) throw new Error('Calve cancelled.');
    if (isExcluded(e.path, LIMITS.excluded)) continue;

    const rec = { p: e.path, m: e.mode, u: e.uid | 0, g: e.gid | 0, t: e.mtime | 0 };

    if ((e.mode & S_IFMT) === S_IFLNK) {
      rec.l = e.target ?? '';
    } else if ((e.mode & S_IFMT) === S_IFDIR) {
      // directories carry metadata only
    } else if ((e.mode & S_IFMT) === S_IFREG || e.size != null) {
      if (e.size > LIMITS.maxFileBytes) {
        const err = new Error(
          `${e.path} is ${(e.size / 1048576).toFixed(0)} MB. Iceberg refuses single ` +
          `files over ${LIMITS.maxFileBytes / 1048576} MB — GitHub will not take them ` +
          `reliably. Move it out of the machine, or delete it, and calve again.`
        );
        err.path = e.path;
        throw err;
      }
      const bytes = await fs.read(e.path);
      rec.s = bytes.length;
      rec.off = cutter.total;
      rec.h = await sha256(bytes);
      await cutter.push(bytes);
      totalBytes += bytes.length;
    }

    files.push(rec);
    scanned++;
    if (onProgress && scanned % 64 === 0) onProgress({ phase: 'read', done: scanned, total: entries.length, bytes: totalBytes });
  }

  await cutter.flush();
  onProgress?.({ phase: 'read', done: entries.length, total: entries.length, bytes: totalBytes });

  return {
    index: { v: 1, files, streamBytes: cutter.total, fileCount: files.length, dataBytes: totalBytes },
    chunks: cutter.chunks,
  };
}

/* ---------------------------------------------------------------- */
/* the index, as its own chunked stream                              */
/* ---------------------------------------------------------------- */

export async function packIndex(index) {
  const json = enc.encode(JSON.stringify(index));
  const gz = await deflate(json);
  const chunks = await cut(gz, sha256);
  return { bytes: gz, chunks, rawBytes: json.length };
}

export async function unpackIndex(parts) {
  const gz = concatBytes(parts);
  const json = await inflate(gz);
  return JSON.parse(dec.decode(json));
}

/* ---------------------------------------------------------------- */
/* restore                                                           */
/* ---------------------------------------------------------------- */

/** Which chunks cover [off, off+size) in the stream. */
export function chunksFor(streamChunks, off, size) {
  const out = [];
  const end = off + size;
  for (const c of streamChunks) {
    const cEnd = c.off + c.len;
    if (cEnd <= off) continue;
    if (c.off >= end) break;
    out.push(c);
  }
  return out;
}

/** Assemble one file's bytes from already-fetched chunk buffers. */
export function sliceFile(streamChunks, chunkBytes, off, size) {
  if (!size) return new Uint8Array(0);
  const out = new Uint8Array(size);
  let written = 0;
  for (const c of chunksFor(streamChunks, off, size)) {
    const buf = chunkBytes.get(c.hash);
    if (!buf) throw new Error(`Missing piece ${c.hash.slice(0, 12)}… while rebuilding a file.`);
    const from = Math.max(0, off - c.off);
    const to = Math.min(c.len, off + size - c.off);
    out.set(buf.subarray(from, to), written);
    written += to - from;
  }
  if (written !== size) throw new Error('A file came back the wrong length. The floe may be damaged.');
  return out;
}

/* ---------------------------------------------------------------- */
/* v86 filesystem adapter                                            */
/* ---------------------------------------------------------------- */

/**
 * Build v86's JSON filesystem description (format version 3) from an index.
 *
 * Entry shape, per v86's own loader:
 *   [ name, size, mtime, mode, uid, gid, payload ]
 * where payload is the children array for a directory, the target for a
 * symlink, and the content hash for a regular file. The hash is what v86 asks
 * our loader for, which is why the index carries a per-file sha256 as well as
 * the stream offsets.
 *
 * If a future v86 changes this format, this function is the only place that
 * has to change.
 */
export function toBaseFS(index) {
  const root = { name: '', dirs: new Map(), files: [], meta: null };

  const ensure = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [], meta: null });
      node = node.dirs.get(part);
    }
    return node;
  };

  for (const f of index.files) {
    const parts = normPath(f.p).split('/').filter(Boolean);
    const kind = f.m & S_IFMT;
    if (kind === S_IFDIR) {
      ensure(parts).meta = f;
    } else {
      const parent = ensure(parts.slice(0, -1));
      parent.files.push({ name: parts[parts.length - 1], rec: f });
    }
  }

  const emit = (node) => {
    const out = [];
    for (const [, d] of [...node.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const m = d.meta;
      out.push([
        d.name,
        0,
        m?.t ?? 0,
        m?.m ?? (S_IFDIR | 0o755),
        m?.u ?? 0,
        m?.g ?? 0,
        emit(d),
      ]);
    }
    for (const f of node.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = f.rec;
      const kind = r.m & S_IFMT;
      if (kind === S_IFLNK) {
        out.push([f.name, 0, r.t | 0, r.m, r.u | 0, r.g | 0, r.l ?? '']);
      } else if (r.s > 0) {
        out.push([f.name, r.s, r.t | 0, r.m, r.u | 0, r.g | 0, r.h]);
      } else {
        out.push([f.name, 0, r.t | 0, r.m, r.u | 0, r.g | 0]);
      }
    }
    return out;
  };

  return {
    fsroot: emit(root),
    version: 3,
    size: index.dataBytes ?? 0,
    total_size: index.dataBytes ?? 0,
  };
}

/** hash → {off,size} so the lazy loader can answer v86's requests. */
export function contentMap(index) {
  const m = new Map();
  for (const f of index.files) {
    if (f.h && f.s) m.set(f.h, { off: f.off, size: f.s, path: f.p });
  }
  return m;
}
