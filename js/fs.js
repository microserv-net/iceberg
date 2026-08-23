/* ICEBERG — the filesystem bridge.
 *
 * The guest's root filesystem is a 9p tree that lives in JavaScript memory, not
 * inside a disk image. Two consequences run through the whole product:
 *
 *   1. The editor can read and write files while the processor is parked. The
 *      machine does not have to be running for its files to exist.
 *   2. Drift can be measured without hashing anything: size, mtime and mode
 *      against the index the session was thawed from.
 *
 * This module is the only place that touches v86's internals. If v86 changes,
 * it changes here.
 */

import { S_IFMT, S_IFDIR, S_IFREG, S_IFLNK } from './snapshot.js';
import { LIMITS } from './config.js';
import { enc, dec, normPath, dirname, basename, isExcluded } from './util.js';

export class GuestFS {
  #fs;                     // v86 FS instance (emulator.fs9p)
  #emulator;
  baseline = new Map();    // path → {s,t,m} as of the thaw

  constructor(emulator) {
    this.#emulator = emulator;
    this.#fs = emulator?.fs9p ?? null;
    if (!this.#fs) throw new Error('This machine was built without a 9p filesystem.');
  }

  /* ---- walking ---- */

  /**
   * Every inode, as {path, mode, size, mtime, uid, gid, target}.
   * v86 keeps a flat inode array with directory entries as name → index maps,
   * so a full walk is a tree traversal over in-memory objects: no I/O, no
   * guest involvement, and fast enough to run before every calve.
   */
  async walk() {
    const out = [];
    const fs = this.#fs;
    const visit = (idx, path, depth) => {
      if (depth > 64) return;
      const inode = fs.inodes[idx];
      if (!inode) return;
      const mode = inode.mode ?? 0;
      const kind = mode & S_IFMT;

      if (path !== '/') {
        out.push({
          path,
          mode,
          size: inode.size ?? 0,
          mtime: Math.floor((inode.mtime ?? 0)),
          uid: inode.uid ?? 0,
          gid: inode.gid ?? 0,
          target: inode.symlink ?? null,
          idx,
        });
      }

      if (kind === S_IFDIR) {
        if (isExcluded(path === '/' ? '/' : path + '/', LIMITS.excluded)) return;
        const entries = inode.direntries;
        if (!entries) return;
        for (const [name, child] of entries) {
          if (name === '.' || name === '..') continue;
          visit(child, path === '/' ? `/${name}` : `${path}/${name}`, depth + 1);
        }
      }
    };
    visit(0, '/', 0);
    return out;
  }

  async list(path = '/') {
    const p = normPath(path);
    const idx = this.#lookup(p);
    if (idx == null) throw new Error(`${p} does not exist on this machine.`);
    const inode = this.#fs.inodes[idx];
    if ((inode.mode & S_IFMT) !== S_IFDIR) throw new Error(`${p} is not a folder.`);
    const out = [];
    for (const [name, child] of inode.direntries ?? []) {
      if (name === '.' || name === '..') continue;
      const ci = this.#fs.inodes[child];
      if (!ci) continue;
      const kind = ci.mode & S_IFMT;
      out.push({
        name,
        path: p === '/' ? `/${name}` : `${p}/${name}`,
        kind: kind === S_IFDIR ? 'dir' : kind === S_IFLNK ? 'link' : 'file',
        size: ci.size ?? 0,
        mode: ci.mode,
        mtime: ci.mtime ?? 0,
        target: ci.symlink ?? null,
      });
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return out;
  }

  #lookup(path) {
    const parts = normPath(path).split('/').filter(Boolean);
    let idx = 0;
    for (const part of parts) {
      const found = this.#fs.Search(idx, part);
      if (found === -1 || found == null) return null;
      idx = found;
    }
    return idx;
  }

  exists(path) { return this.#lookup(path) != null; }

  stat(path) {
    const idx = this.#lookup(path);
    if (idx == null) return null;
    const i = this.#fs.inodes[idx];
    return { size: i.size ?? 0, mode: i.mode, mtime: i.mtime ?? 0, uid: i.uid ?? 0, gid: i.gid ?? 0 };
  }

  /* ---- reading and writing ---- */

  async read(path) {
    const p = normPath(path);
    const data = await this.#emulator.read_file(p.replace(/^\//, ''));
    if (!data) return new Uint8Array(0);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  async readText(path) { return dec.decode(await this.read(path)); }

  async write(path, data) {
    const p = normPath(path);
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (bytes.length > LIMITS.maxFileBytes) {
      throw new Error(`That file is larger than Iceberg will carry into a floe.`);
    }
    await this.#ensureDir(dirname(p));
    await this.#emulator.create_file(p.replace(/^\//, ''), bytes);
    this.touched = true;
    return bytes.length;
  }

  async #ensureDir(path) {
    const parts = normPath(path).split('/').filter(Boolean);
    let idx = 0;
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      const found = this.#fs.Search(idx, part);
      if (found === -1 || found == null) {
        idx = this.#fs.CreateDirectory(part, idx);
      } else idx = found;
    }
    return idx;
  }

  async mkdir(path) { await this.#ensureDir(path); }

  async unlink(path) {
    const p = normPath(path);
    const parent = this.#lookup(dirname(p));
    if (parent == null) throw new Error(`${dirname(p)} does not exist.`);
    const ok = this.#fs.Unlink(parent, basename(p));
    if (ok === false) throw new Error(`Could not remove ${p}.`);
    this.touched = true;
  }

  /* ---- drift ---- */

  /** Record the state a session was thawed from. */
  setBaseline(index) {
    this.baseline = new Map();
    for (const f of index.files) this.baseline.set(f.p, { s: f.s ?? 0, t: f.t ?? 0, m: f.m });
  }

  /**
   * What has changed since the thaw. Metadata only — no hashing — so this can
   * run every few seconds while the machine is awake without costing anything
   * the user would notice.
   */
  async drift() {
    const now = await this.walk();
    const seen = new Set();
    const added = [];
    const changed = [];
    let bytes = 0;

    for (const e of now) {
      seen.add(e.path);
      const was = this.baseline.get(e.path);
      const kind = e.mode & S_IFMT;
      if (!was) {
        added.push(e.path);
        if (kind === S_IFREG) bytes += e.size ?? 0;
      } else if (was.s !== (e.size ?? 0) || was.t !== e.mtime || was.m !== e.mode) {
        changed.push(e.path);
        if (kind === S_IFREG) bytes += e.size ?? 0;
      }
    }

    const removed = [];
    for (const p of this.baseline.keys()) if (!seen.has(p)) removed.push(p);

    return {
      added, changed, removed, bytes,
      count: added.length + changed.length + removed.length,
      clean: added.length + changed.length + removed.length === 0,
    };
  }

  /** A short, human list for the confirmation dialog — never the whole diff. */
  static summarise(drift, limit = 6) {
    const notable = [...drift.added, ...drift.changed]
      .filter((p) => !p.startsWith('/root/.ash_history'))
      .sort((a, b) => a.length - b.length)
      .slice(0, limit);
    return notable;
  }
}
