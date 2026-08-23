/* ICEBERG — content-defined chunking.
 *
 * Deliberately dependency-free apart from the constants, because this algorithm
 * has to agree, byte for byte, with tools/build-image.mjs running under Node.
 * If the two ever disagree about where a boundary falls, every user's calve
 * stops matching the public base image and every vault silently doubles in
 * size. Keeping it here, importable and testable on its own, is the guard.
 *
 * Gear hash: h = (h << 1) + G[byte]. A boundary is where the low bits of h are
 * zero. Because h depends only on the bytes just read, the same content
 * produces the same boundary wherever it appears in the stream — which is the
 * property fixed-size blocks lack and the reason dedup survives an insertion.
 */

import { KEEL } from './config.js';

/** The table. Fixed seed, xorshift32. Never change the seed. */
export const GEAR = (() => {
  const t = new Uint32Array(256);
  let s = 0x1f2e3d4c;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    t[i] = s;
  }
  return t;
})();

/**
 * Where the next boundary falls in `view`, or 0 if there is not enough data to
 * decide yet. `final` forces a cut at whatever is left.
 */
export function findBoundary(view, final = false) {
  const { minChunk, maxChunk, mask } = KEEL;
  if (view.length <= minChunk) return final ? view.length : 0;
  const limit = Math.min(view.length, maxChunk);
  let h = 0;
  for (let i = minChunk; i < limit; i++) {
    h = ((h << 1) + GEAR[view[i]]) >>> 0;
    if ((h & mask) === 0) return i + 1;
  }
  if (limit === maxChunk) return maxChunk;
  return final ? view.length : 0;
}

/**
 * Split a complete buffer. Used for things already in memory — a packed index,
 * a memory image. Large filesystems go through StreamCutter instead, which
 * holds only a window.
 */
export async function cut(bytes, hash, onProgress) {
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    const view = bytes.subarray(start);
    const end = start + findBoundary(view, true);
    const slice = bytes.subarray(start, end);
    out.push({ hash: await hash(slice), off: start, len: slice.length });
    start = end;
    if (onProgress && out.length % 16 === 0) onProgress(start, bytes.length);
  }
  return out;
}

/**
 * Accepts pushed bytes, emits chunks as boundaries are found, and holds at most
 * two maximum chunks. A 400 MB filesystem is captured without a 400 MB buffer,
 * which is the difference between working on a phone and not.
 */
export class StreamCutter {
  #buf;
  #len = 0;
  #offset = 0;
  #onChunk;
  #hash;
  total = 0;
  chunks = [];

  constructor(onChunk, hash) {
    this.#buf = new Uint8Array(KEEL.maxChunk * 2);
    this.#onChunk = onChunk;
    this.#hash = hash;
  }

  async push(bytes) {
    let i = 0;
    while (i < bytes.length) {
      const take = Math.min(this.#buf.length - this.#len, bytes.length - i);
      this.#buf.set(bytes.subarray(i, i + take), this.#len);
      this.#len += take;
      i += take;
      this.total += take;
      while (this.#len >= KEEL.maxChunk) {
        if (!(await this.#drain(false))) break;
      }
    }
  }

  async #drain(final) {
    if (this.#len === 0) return false;
    const view = this.#buf.subarray(0, this.#len);
    const at = findBoundary(view, final);
    if (at <= 0) return false;
    const slice = view.slice(0, at);
    const hash = await this.#hash(slice);
    this.chunks.push({ hash, off: this.#offset, len: slice.length });
    await this.#onChunk(hash, slice, this.#offset);
    this.#buf.copyWithin(0, at, this.#len);
    this.#len -= at;
    this.#offset += at;
    return true;
  }

  async flush() {
    while (this.#len > 0) {
      if (!(await this.#drain(true))) break;
    }
    return this.chunks;
  }
}
