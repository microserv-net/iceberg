/* ICEBERG — the session.
 *
 * A floe is what you saved. A session is what you are using. The distinction
 * is the product, so it is enforced here rather than implied by the interface:
 *
 *   Nothing that happens inside a running machine is ever written to GitHub.
 *
 * There is no autosave, no background commit, no "syncing" indicator that
 * quietly persists your work. Installing four hundred packages and deleting the
 * kernel are, as far as the vault is concerned, the same event: none.
 *
 * What the session does owe you is not losing that work by accident. Three
 * layers, in order of how much they cost:
 *
 *   drift    a cheap metadata diff, so the interface always knows what is at stake
 *   spill    changed small files copied to local storage every minute
 *   submerged   the entire machine written locally when the tab goes away
 */

import { MACHINE, IMAGES, BASE_NAME } from './config.js';
import { machine } from './machine.js';
import { idb, requestPersistence } from './idb.js';
import * as Floes from './floes.js';
import { loadImage } from './image.js';
import { GuestFS } from './fs.js';
import { Emitter, sleep, bytesHuman } from './util.js';

const SPILL_INTERVAL = 60_000;
const DRIFT_INTERVAL = 6_000;
const SPILL_MAX_FILE = 512 * 1024;

export class Session extends Emitter {
  floeId = null;
  floeName = null;
  source = null;
  image = null;
  identity = null;
  startedAt = null;
  drift = { count: 0, bytes: 0, added: [], changed: [], removed: [], clean: true };
  #driftTimer = null;
  #spillTimer = null;
  #guarded = false;

  get machine() { return machine; }
  get fs() { return machine.fs; }
  get memoryMB() { return MACHINE.memoryMB; }
  get v86Version() { return machine.emulator?.v86?.version ?? null; }
  get dirty() { return this.drift.count > 0; }
  get label() { return this.floeName ? `${this.floeName} — this session` : 'Unsaved machine'; }

  /* ---------------------------------------------------------------- */
  /* starting                                                          */
  /* ---------------------------------------------------------------- */

  /** Thaw a floe, or the factory image when the vault is brand new. */
  async begin({ floeId = null, imageId = IMAGES.default, identity = null, screen, onStage } = {}) {
    await this.end({ silent: true });
    this.startedAt = Date.now();
    this.identity = identity ?? Floes.setup();

    let source;
    if (floeId) {
      const entry = Floes.byId(floeId);
      onStage?.('resolving', { label: `Thawing ${entry?.name ?? 'floe'}` });
      source = await Floes.thaw(floeId, { onProgress: (p) => onStage?.(p.phase, p) });
      this.floeId = floeId;
      this.floeName = entry?.name ?? null;
      this.image = await loadImage(source.manifest.image?.id ?? imageId).catch(() => null);
    } else {
      onStage?.('resolving', { label: 'Reading the factory machine' });
      const img = await loadImage(imageId, { onProgress: (p) => onStage?.(p.phase, p) });
      source = img;
      this.image = img;
      this.floeId = null;
      this.floeName = null;
    }
    this.source = source;

    await machine.thaw(source, { identity: this.identity, screen, onStage });

    if (machine.fs) {
      machine.fs.setBaseline(source.index);
    }

    requestPersistence().then((r) => {
      if (r.supported && !r.granted) {
        this.emit('warning', {
          key: 'persistence',
          message: 'This browser has not promised to keep local storage. If it runs short of space ' +
                   'it may discard an uncalved session. Calve anything you care about.',
        });
      }
    }).catch(() => {});

    this.#watch();
    this.#guard();
    this.emit('began', { floeId, name: this.floeName });
    return this;
  }

  /* ---------------------------------------------------------------- */
  /* drift and spill                                                   */
  /* ---------------------------------------------------------------- */

  #watch() {
    clearInterval(this.#driftTimer);
    clearInterval(this.#spillTimer);
    this.#driftTimer = setInterval(() => this.measure().catch(() => {}), DRIFT_INTERVAL);
    this.#spillTimer = setInterval(() => this.spill().catch(() => {}), SPILL_INTERVAL);
  }

  async measure() {
    if (!machine.fs || machine.state === 'submerged') return this.drift;
    const d = await machine.fs.drift();
    const changed = d.count !== this.drift.count || d.bytes !== this.drift.bytes;
    this.drift = d;
    if (changed) this.emit('drift', d);
    return d;
  }

  /**
   * Copy changed small files to local storage. This is not a backup of the
   * machine — it is a way for a person whose browser died mid-sentence to get
   * their file back. It says exactly that in the interface.
   */
  async spill() {
    if (!machine.fs || !this.dirty || machine.state === 'submerged') return 0;
    const targets = [...this.drift.added, ...this.drift.changed];
    const out = [];
    for (const p of targets) {
      const st = machine.fs.stat(p);
      if (!st || st.size > SPILL_MAX_FILE) continue;
      try { out.push([`spill:${p}`, { path: p, bytes: await machine.fs.read(p), at: Date.now() }]); }
      catch { /* a file that vanished between the walk and the read is not an error */ }
      if (out.length >= 200) break;
    }
    if (out.length) await idb.putMany('session', out);
    await idb.set('session', 'spill:meta', {
      at: new Date().toISOString(), count: out.length,
      floeId: this.floeId, floeName: this.floeName,
    });
    this.emit('spilled', { count: out.length });
    return out.length;
  }

  static async spilledFiles() {
    const keys = (await idb.keys('session')).filter((k) => String(k).startsWith('spill:') && k !== 'spill:meta');
    const meta = await idb.get('session', 'spill:meta');
    return { keys, meta };
  }

  static async clearSpill() {
    const keys = (await idb.keys('session')).filter((k) => String(k).startsWith('spill:'));
    for (const k of keys) await idb.del('session', k);
  }

  /* ---------------------------------------------------------------- */
  /* calving and melting                                           */
  /* ---------------------------------------------------------------- */

  async calveAs(name, opts = {}) {
    const wasRunning = machine.state === 'running';
    machine.park('calving');
    try {
      const result = await Floes.calve(this, name, opts);
      // The session continues, but it is now a session of the new floe and
      // its drift starts again from zero. That is what "saved" means.
      this.floeId = result.id;
      this.floeName = result.entry.name;
      if (machine.fs) {
        const resolved = await Floes.thaw(result.id);
        machine.fs.setBaseline(resolved.index);
        this.source = { ...this.source, ...resolved };
      }
      await this.measure();
      await Session.clearSpill();
      this.emit('calved', result.stats);
      return result;
    } finally {
      if (wasRunning) await machine.wake();
    }
  }

  /** Throw away everything since the thaw and come back up from the floe. */
  async melt({ screen, onStage } = {}) {
    const id = this.floeId;
    await Session.clearSpill();
    await machine.scuttle({ silent: true });
    await this.begin({ floeId: id, screen, onStage, identity: this.identity });
    this.emit('melted', { floeId: id });
  }

  /* ---------------------------------------------------------------- */
  /* leaving                                                           */
  /* ---------------------------------------------------------------- */

  #guard() {
    if (this.#guarded) return;
    this.#guarded = true;

    // The browser only lets us say "there is something here"; it will not show
    // our words. The real conversation happens in the app's own dialog, which
    // is why every in-app route change asks first.
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    // pagehide is the one event mobile browsers reliably deliver before they
    // take the tab away. Submerged is the whole point of it.
    window.addEventListener('pagehide', () => {
      if (!machine.emulator) return;
      machine.park('tab hidden');
      // Best effort: a synchronous submerged is impossible, so this may not finish.
      // The interface never claims it did.
      if (MACHINE.submergedOnHide) machine.deepen('tab hidden').catch(() => {});
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        machine.park('tab in the background');
      }
    });
  }

  async end({ silent = false } = {}) {
    clearInterval(this.#driftTimer);
    clearInterval(this.#spillTimer);
    await machine.scuttle({ silent });
    if (!silent) this.emit('ended');
    this.floeId = null;
    this.floeName = null;
    this.drift = { count: 0, bytes: 0, added: [], changed: [], removed: [], clean: true };
  }

  /** What the leave dialog says. Specific, never generic. */
  describeDrift() {
    const d = this.drift;
    if (!d.count) return 'Nothing has changed since you thawed this machine.';
    const bits = [];
    if (d.added.length) bits.push(`${d.added.length} new ${d.added.length === 1 ? 'file' : 'files'}`);
    if (d.changed.length) bits.push(`${d.changed.length} changed`);
    if (d.removed.length) bits.push(`${d.removed.length} removed`);
    return `${bits.join(', ')} — ${bytesHuman(d.bytes)} of drift.`;
  }
}

export const session = new Session();
