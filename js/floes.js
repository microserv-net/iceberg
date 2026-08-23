/* ICEBERG — floes.
 *
 * A floe is a saved machine. Internally it is a commit; the user sees a name
 * and a date. This module owns the index that maps one to the other, and the
 * two operations that matter: calve (session → floe) and thaw (floe →
 * session).
 *
 * The index is a file in the vault, not a database. If it is ever lost or
 * damaged it can be rebuilt from the floe manifests, which are the truth.
 */

import { APP, BASE_NAME, KEEL, LIMITS, IMAGES } from './config.js';
import { gh } from './github.js';
import { repo, readJSON, commit, refresh, movedElsewhere } from './vault.js';
import {
  getChunk, getChunks, putChunks, knownFromManifests, noteWritten, resolveVaultBlobs,
} from './keel.js';
import {
  capture, packIndex, unpackIndex, chunksFor, sliceFile, toBaseFS, contentMap,
} from './snapshot.js';
import { idb } from './idb.js';
import {
  ulid, deflate, toBase64, sha256, Emitter, bytesHuman, Deferred, sleep,
} from './util.js';

export const floes = new Emitter();

let index = null;                      // the parsed index.json
let manifestCache = new Map();         // id → manifest

/* ---------------------------------------------------------------- */
/* the index                                                         */
/* ---------------------------------------------------------------- */

export async function loadIndex({ force = false } = {}) {
  if (index && !force) return index;
  const doc = await readJSON('index.json');
  index = doc ?? { schema: APP.schema, updated: null, floes: [], setup: null };
  floes.emit('index', index);
  return index;
}

export const list = () => (index?.floes ?? []).slice().sort((a, b) => {
  if (a.name === BASE_NAME) return -1;
  if (b.name === BASE_NAME) return 1;
  return (b.created ?? '').localeCompare(a.created ?? '');
});

export const setup = () => index?.setup ?? null;
export const byId = (id) => (index?.floes ?? []).find((c) => c.id === id) ?? null;
export const byName = (name) => (index?.floes ?? []).find(
  (c) => c.name.toLowerCase() === String(name).toLowerCase()
) ?? null;
export const base = () => (index?.floes ?? []).find((c) => c.name === BASE_NAME) ?? null;

/** Validation the user sees before the button lights up. */
export function checkName(name, { allowId = null } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, why: 'Give it a name you will recognise in six months.' };
  if (n.length > LIMITS.stateNameMax) return { ok: false, why: `Keep it under ${LIMITS.stateNameMax} characters.` };
  if (!LIMITS.stateNameRe.test(n)) return { ok: false, why: 'Letters, numbers, spaces and . _ + # ( ) - only.' };
  if (n.toUpperCase() === BASE_NAME && allowId !== base()?.id) {
    return { ok: false, why: `${BASE_NAME} is the factory machine. It cannot be reused as a name.` };
  }
  const clash = byName(n);
  if (clash && clash.id !== allowId) return { ok: false, why: `You already have a floe called “${clash.name}”.` };
  if ((index?.floes?.length ?? 0) >= LIMITS.maxFloes && !allowId) {
    return { ok: false, why: `${LIMITS.maxFloes} floes is the ceiling. Forget one first.` };
  }
  return { ok: true, name: n };
}

export async function manifest(id) {
  if (manifestCache.has(id)) return manifestCache.get(id);
  const local = await idb.get('meta', `manifest:${id}`);
  if (local) { manifestCache.set(id, local); return local; }
  const m = await readJSON(`floes/${id}.json`);
  if (!m) throw new Error('That floe’s manifest is missing from the vault.');
  manifestCache.set(id, m);
  idb.set('meta', `manifest:${id}`, m).catch(() => {});
  return m;
}

async function allManifests() {
  const out = [];
  for (const c of index?.floes ?? []) {
    try { out.push(await manifest(c.id)); } catch { /* a damaged manifest must not block a calve */ }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* calve                                                            */
/* ---------------------------------------------------------------- */

class Gate {
  #limit; #active = 0; #queue = [];
  constructor(limit) { this.#limit = limit; }
  async acquire() {
    if (this.#active < this.#limit) { this.#active++; return; }
    const d = new Deferred();
    this.#queue.push(d);
    await d.promise;
    this.#active++;
  }
  release() { this.#active--; this.#queue.shift()?.resolve(); }
}

/**
 * Calve the live session into a new floe.
 *
 * Order matters and is deliberate: every chunk is uploaded first, then the
 * index, then — as the last act — one commit that introduces the manifest and
 * the index entry together. Until that commit lands, nothing in the vault
 * refers to any of the new blobs, so an interrupted calve is invisible rather
 * than half-applied.
 */
export async function calve(session, name, {
  warm = false, note = '', onProgress, signal,
} = {}) {
  const check = checkName(name);
  if (!check.ok) throw new Error(check.why);

  const started = performance.now();
  const parent = session.floeId ?? null;
  const parentFloe = parent ? byId(parent) : null;
  const id = ulid();
  const report = (phase, detail = {}) => onProgress?.({ phase, ...detail });

  report('preparing', { label: 'Reading what your vault already holds' });
  await resolveVaultBlobs({ force: true });
  const known = knownFromManifests(await allManifests());
  const baseImage = session.image;
  if (baseImage?.chunkSet) for (const h of baseImage.chunkSet) known.add(h);

  /* ---- capture and upload in one pass ---- */
  const gate = new Gate(KEEL.uploadConcurrency);
  const seen = new Set();
  const entries = [];
  const uploads = [];
  let uploadedChunks = 0, uploadedBytes = 0, sharedChunks = 0;

  const onChunk = async (hash, bytes) => {
    if (signal?.aborted) throw new Error('Calve cancelled.');
    if (known.has(hash) || seen.has(hash)) { sharedChunks++; return; }
    seen.add(hash);
    await gate.acquire();
    const job = (async () => {
      try {
        const stored = KEEL.compress ? await deflate(bytes) : bytes;
        const b64 = toBase64(stored);
        const sha = await gh.putBlob(repo.owner, repo.name, b64);
        entries.push({ path: `keel/${hash.slice(0, 2)}/${hash}`, sha });
        uploadedChunks++; uploadedBytes += b64.length;
        idb.set('cache', `c:${hash}`, bytes).catch(() => {});
        report('uploading', { uploadedChunks, uploadedBytes, sharedChunks });
        await gh.breathe();
      } finally { gate.release(); }
    })();
    uploads.push(job);
    // Surface an upload failure immediately rather than at the final await.
    job.catch(() => {});
  };

  report('reading', { label: 'Reading the machine' });
  const { index: fsIndex, chunks } = await capture(session.fs, {
    onChunk,
    signal,
    onProgress: (p) => report('reading', p),
  });
  await Promise.all(uploads);
  if (signal?.aborted) throw new Error('Calve cancelled.');

  /* ---- the file index, chunked the same way ---- */
  report('indexing', { label: 'Writing the index' });
  fsIndex.image = session.image?.id ?? IMAGES.default;
  const packed = await packIndex(fsIndex);
  const indexChunkHashes = [];
  for (const c of packed.chunks) {
    indexChunkHashes.push(c.hash);
    if (known.has(c.hash) || seen.has(c.hash)) { sharedChunks++; continue; }
    seen.add(c.hash);
    const bytes = packed.bytes.subarray(c.off, c.off + c.len);
    const stored = KEEL.compress ? await deflate(bytes) : bytes;
    const sha = await gh.putBlob(repo.owner, repo.name, toBase64(stored));
    entries.push({ path: `keel/${c.hash.slice(0, 2)}/${c.hash}`, sha });
    uploadedChunks++;
  }

  /* ---- optional warm image: RAM and devices as they stand ---- */
  let warmRec = null;
  if (warm && session.warmImage) {
    report('warm', { label: 'Calving memory as well' });
    const wc = await session.warmImage();          // Uint8Array
    const wchunks = [];
    const { cut } = await import('./chunker.js');
    const wcChunks = await cut(wc, sha256);
    for (const c of wcChunks) {
      wchunks.push(c.hash);
      if (known.has(c.hash) || seen.has(c.hash)) { sharedChunks++; continue; }
      seen.add(c.hash);
      const bytes = wc.subarray(c.off, c.off + c.len);
      const stored = KEEL.compress ? await deflate(bytes) : bytes;
      const sha = await gh.putBlob(repo.owner, repo.name, toBase64(stored));
      entries.push({ path: `keel/${c.hash.slice(0, 2)}/${c.hash}`, sha });
      uploadedChunks++;
      report('warm', { uploadedChunks });
      await gh.breathe();
    }
    warmRec = { chunks: wchunks, bytes: wc.length, memoryMB: session.memoryMB, v86: session.v86Version ?? null };
  }

  /* ---- the manifest, and the commit that makes all of it real ---- */
  const doc = {
    schema: APP.schema,
    id,
    name: check.name,
    created: new Date().toISOString(),
    parent,
    parentName: parentFloe?.name ?? null,
    note: String(note ?? '').slice(0, 280),
    client: APP.client,
    device: navigator.userAgent.slice(0, 120),
    image: { id: session.image?.id ?? IMAGES.default, sha256: session.image?.sha256 ?? null },
    machine: {
      memoryMB: session.memoryMB,
      arch: 'x86',
      hostname: session.identity?.hostname ?? null,
      username: session.identity?.username ?? null,
      timezone: session.identity?.timezone ?? null,
    },
    fs: {
      fileCount: fsIndex.fileCount,
      dataBytes: fsIndex.dataBytes,
      streamBytes: fsIndex.streamBytes,
      streamChunks: chunks.map((c) => ({ h: c.hash, o: c.off, n: c.len })),
      indexChunks: indexChunkHashes,
    },
    warm: warmRec,
  };

  report('committing', { label: 'Sealing the floe' });

  if (await movedElsewhere()) {
    await refresh();
    await loadIndex({ force: true });
    const clash = byName(check.name);
    if (clash) {
      throw new Error(
        `While you were calving, another device saved a floe called “${check.name}”. ` +
        `Nothing was lost — choose a different name and calve again.`
      );
    }
  }

  const entry = {
    id,
    name: check.name,
    created: doc.created,
    parent,
    image: doc.image.id,
    fileCount: fsIndex.fileCount,
    bytes: fsIndex.dataBytes,
    warm: !!warmRec,
    note: doc.note,
  };
  const nextIndex = {
    ...(index ?? { schema: APP.schema }),
    schema: APP.schema,
    updated: new Date().toISOString(),
    floes: [...(index?.floes ?? []), entry],
    setup: index?.setup ?? session.identity ?? null,
  };

  await commit({
    message: `iceberg: calve “${check.name}”${parentFloe ? ` from “${parentFloe.name}”` : ''}`,
    blobs: entries,
    files: [
      { path: `floes/${id}.json`, text: JSON.stringify(doc, null, 2) },
      { path: 'index.json', text: JSON.stringify(nextIndex, null, 2) },
    ],
  });

  noteWritten(entries);
  index = nextIndex;
  manifestCache.set(id, doc);
  idb.set('meta', `manifest:${id}`, doc).catch(() => {});

  const stats = {
    id, name: check.name, ms: performance.now() - started,
    uploadedChunks, sharedChunks, uploadedBytes,
    fileCount: fsIndex.fileCount, dataBytes: fsIndex.dataBytes,
  };
  floes.emit('calved', stats);
  report('done', stats);
  return { id, entry, manifest: doc, stats };
}

/* ---------------------------------------------------------------- */
/* thaw                                                              */
/* ---------------------------------------------------------------- */

/**
 * Resolve a floe into everything the machine needs to come up: the file
 * index, the stream chunk table, and a lazy reader that fetches only the pieces
 * the guest actually touches.
 */
export async function thaw(id, { onProgress, signal } = {}) {
  const entry = byId(id);
  if (!entry) throw new Error('That floe is not in your vault any more.');
  const doc = await manifest(id);
  onProgress?.({ phase: 'index', label: 'Reading the index' });

  const parts = [];
  let n = 0;
  for (const h of doc.fs.indexChunks) {
    parts.push(await getChunk(h, { imageId: doc.image?.id, signal }));
    onProgress?.({ phase: 'index', done: ++n, total: doc.fs.indexChunks.length });
  }
  const fsIndex = await unpackIndex(parts);
  const streamChunks = doc.fs.streamChunks.map((c) => ({ hash: c.h, off: c.o, len: c.n }));

  return {
    entry,
    manifest: doc,
    index: fsIndex,
    streamChunks,
    baseFS: toBaseFS(fsIndex),
    contentMap: contentMap(fsIndex),

    /** Bytes for one file, by its content hash — this is what v86 asks for. */
    async readByHash(hash) {
      const loc = contentMap(fsIndex).get(hash);
      if (!loc) throw new Error(`No file in this floe has hash ${hash.slice(0, 12)}…`);
      const needed = chunksFor(streamChunks, loc.off, loc.size);
      const got = await getChunks(needed.map((c) => c.hash), { imageId: doc.image?.id, signal });
      return sliceFile(streamChunks, got, loc.off, loc.size);
    },

    /** Pull everything, for offline use or a fast first boot on a fat pipe. */
    async prefetch(onTick) {
      const hashes = streamChunks.map((c) => c.hash);
      await getChunks(hashes, {
        imageId: doc.image?.id, signal,
        onProgress: (done, total) => onTick?.({ done, total }),
      });
    },
  };
}

/* ---------------------------------------------------------------- */
/* rename, forget, notes                                             */
/* ---------------------------------------------------------------- */

export async function rename(id, name) {
  const entry = byId(id);
  if (!entry) throw new Error('No such floe.');
  if (entry.name === BASE_NAME) throw new Error(`${BASE_NAME} keeps its name. It is the factory machine.`);
  const check = checkName(name, { allowId: id });
  if (!check.ok) throw new Error(check.why);

  const doc = await manifest(id);
  doc.name = check.name;
  const next = {
    ...index,
    updated: new Date().toISOString(),
    floes: index.floes.map((c) => (c.id === id ? { ...c, name: check.name } : c)),
  };
  await commit({
    message: `iceberg: rename “${entry.name}” to “${check.name}”`,
    files: [
      { path: `floes/${id}.json`, text: JSON.stringify(doc, null, 2) },
      { path: 'index.json', text: JSON.stringify(next, null, 2) },
    ],
  });
  index = next;
  manifestCache.set(id, doc);
  floes.emit('renamed', { id, name: check.name });
}

/**
 * Forget a floe: drop its manifest and its index entry. Its chunks stay in
 * the vault until GitHub's own garbage collection releases the ones nothing
 * else references — which is honest, and is what the confirmation says.
 */
export async function forget(id) {
  const entry = byId(id);
  if (!entry) return;
  if (entry.name === BASE_NAME) {
    throw new Error(`${BASE_NAME} cannot be forgotten. It is the machine you return to.`);
  }
  const children = index.floes.filter((c) => c.parent === id);
  const next = {
    ...index,
    updated: new Date().toISOString(),
    floes: index.floes
      .filter((c) => c.id !== id)
      // A forgotten parent must not leave a dangling lineage pointer.
      .map((c) => (c.parent === id ? { ...c, parent: entry.parent ?? null, orphaned: true } : c)),
  };
  await commit({
    message: `iceberg: forget “${entry.name}”`,
    files: [{ path: 'index.json', text: JSON.stringify(next, null, 2) }],
    deletes: [`floes/${id}.json`],
  });
  index = next;
  manifestCache.delete(id);
  idb.del('meta', `manifest:${id}`).catch(() => {});
  floes.emit('forgotten', { id, name: entry.name, reparented: children.length });
}

export async function saveSetup(identity) {
  const next = { ...(index ?? { schema: APP.schema, floes: [] }), setup: identity, updated: new Date().toISOString() };
  await commit({
    message: 'iceberg: machine identity',
    files: [{ path: 'index.json', text: JSON.stringify(next, null, 2) }],
  });
  index = next;
}

/* ---------------------------------------------------------------- */
/* repair                                                            */
/* ---------------------------------------------------------------- */

/**
 * Rebuild index.json from the floe manifests. The manifests are the record;
 * the index is a convenience. This is the path back from a hand-edited or
 * partially written vault.
 */
export async function rebuildIndex() {
  const tree = await gh.getTree(repo.owner, repo.name, repo.tree, true);
  const ids = tree.tree
    .filter((e) => e.type === 'blob' && /^floes\/[^/]+\.json$/.test(e.path))
    .map((e) => e.path.slice('floes/'.length, -'.json'.length));

  const found = [];
  for (const id of ids) {
    const doc = await readJSON(`floes/${id}.json`);
    if (!doc?.name) continue;
    found.push({
      id: doc.id, name: doc.name, created: doc.created, parent: doc.parent ?? null,
      image: doc.image?.id, fileCount: doc.fs?.fileCount, bytes: doc.fs?.dataBytes,
      warm: !!doc.warm, note: doc.note ?? '',
    });
  }
  const next = {
    schema: APP.schema,
    updated: new Date().toISOString(),
    floes: found,
    setup: index?.setup ?? null,
    rebuilt: new Date().toISOString(),
  };
  await commit({
    message: `iceberg: rebuild the index (${found.length} floes recovered)`,
    files: [{ path: 'index.json', text: JSON.stringify(next, null, 2) }],
  });
  index = next;
  floes.emit('index', index);
  return found.length;
}

/* Lineage, for the interface. */
export function lineage(id) {
  const chain = [];
  let cur = byId(id);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent ? byId(cur.parent) : null;
  }
  return chain;
}
