/* ICEBERG — base images.
 *
 * The factory machine is not stored in anybody's vault. It is published once,
 * publicly, alongside the site, in exactly the same format a floe uses:
 * a manifest plus content-addressed chunks. Every user's BASE points at it.
 *
 * This is the single decision that makes the whole architecture affordable. A
 * clean Alpine root filesystem is tens of thousands of files; writing it into
 * every user's repository through the GitHub API would cost tens of thousands
 * of requests, hundreds of megabytes, and it would be the *same* hundreds of
 * megabytes every time. Pointing at an immutable public copy costs one CDN
 * fetch of only the pieces the guest actually reads.
 *
 * The trade is stated plainly in the documentation: your vault holds everything
 * *you* made, and a pinned reference to a public image. If you would rather be
 * entirely self-contained, `sealImage()` copies it into your vault.
 */

import { IMAGES } from './config.js';
import { unpackIndex, toBaseFS, contentMap, chunksFor, sliceFile } from './snapshot.js';
import { getChunk, getChunks } from './keel.js';

const cache = new Map();

export async function loadImage(id = IMAGES.default, { onProgress, signal } = {}) {
  if (cache.has(id)) return cache.get(id);

  const url = `${IMAGES.baseUrl}${id}/image.json`;
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) {
    throw new Error(
      `The ${id} base image is not published at ${url}. If you are running your ` +
      `own copy of Iceberg, build it with tools/build-image.mjs first.`
    );
  }
  const doc = await res.json();

  onProgress?.({ phase: 'index', label: 'Reading the factory index' });
  const parts = [];
  for (const h of doc.fs.indexChunks) {
    parts.push(await getChunk(h, { imageId: id, signal }));
    onProgress?.({ phase: 'index', done: parts.length, total: doc.fs.indexChunks.length });
  }
  const index = await unpackIndex(parts);
  const streamChunks = doc.fs.streamChunks.map((c) => ({ hash: c.h, off: c.o, len: c.n }));
  const cmap = contentMap(index);

  const image = {
    id,
    doc,
    label: doc.label ?? id,
    os: doc.os ?? 'Alpine Linux',
    version: doc.version ?? null,
    sha256: doc.sha256 ?? null,
    bytes: doc.fs.dataBytes,
    fileCount: doc.fs.fileCount,
    index,
    streamChunks,
    baseFS: toBaseFS(index),
    contentMap: cmap,
    /** Every chunk hash the image contains — a calve never re-uploads these. */
    chunkSet: new Set([...streamChunks.map((c) => c.hash), ...doc.fs.indexChunks]),

    async readByHash(hash) {
      const loc = cmap.get(hash);
      if (!loc) throw new Error(`No file in ${id} has hash ${hash.slice(0, 12)}…`);
      const needed = chunksFor(streamChunks, loc.off, loc.size);
      const got = await getChunks(needed.map((c) => c.hash), { imageId: id, signal });
      return sliceFile(streamChunks, got, loc.off, loc.size);
    },

    async prefetch(onTick) {
      await getChunks(streamChunks.map((c) => c.hash), {
        imageId: id, signal, onProgress: (done, total) => onTick?.({ done, total }),
      });
    },
  };

  cache.set(id, image);
  return image;
}

export async function listImages() {
  try {
    const res = await fetch(`${IMAGES.baseUrl}images.json`, { cache: 'no-cache' });
    if (!res.ok) return [{ id: IMAGES.default, label: 'Alpine Linux', default: true }];
    return await res.json();
  } catch {
    return [{ id: IMAGES.default, label: 'Alpine Linux', default: true }];
  }
}
