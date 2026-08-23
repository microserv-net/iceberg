/* ICEBERG — the machine.
 *
 * One emulated computer, and the honest states it can be in:
 *
 *   cold      nothing is loaded
 *   thawing   pieces are arriving, the machine is being assembled
 *   booting   the processor is running the kernel
 *   running   yours
 *   awash      the run loop is parked. 0% CPU. Memory still held, so waking is
 *             instant and nothing in the machine noticed.
 *   submerged    memory has been written to local storage and the emulator torn
 *             down. Costs nothing at all. Waking takes a moment.
 *   calving  a floe is being written
 *   scuttled  the session is over
 *
 * The two sleep depths are not decoration. A parked run loop is free but still
 * holds half a gigabyte, which a phone will eventually take back without asking.
 * Submerged survives that, and survives a reload.
 *
 * Nothing here ever says the machine is doing work while it is asleep.
 */

import { MACHINE } from './config.js';
import { install as installVirtualOrigin, setHandler, VIRTUAL_ORIGIN } from './vfetch.js';
import { GuestFS } from './fs.js';
import { idb } from './idb.js';
import { Emitter, sleep, Deferred } from './util.js';

export const STATES = ['cold', 'thawing', 'booting', 'running', 'awash', 'submerged', 'calving', 'scuttled', 'failed'];

export class Machine extends Emitter {
  state = 'cold';
  emulator = null;
  fs = null;
  source = null;              // resolved floe or image
  identity = null;
  bootedAt = null;
  lastActivity = Date.now();
  serialBuffer = '';
  #awashTimer = null;
  #submergedTimer = null;
  #bootPromise = null;
  #v86 = null;

  #set(state, detail) {
    if (this.state === state) return;
    const from = this.state;
    this.state = state;
    this.emit('state', { from, to: state, ...detail });
  }

  get awake() { return this.state === 'running' || this.state === 'booting'; }
  get asleep() { return this.state === 'awash' || this.state === 'submerged'; }

  /* ---------------------------------------------------------------- */
  /* bring-up                                                          */
  /* ---------------------------------------------------------------- */

  async #loadV86() {
    if (this.#v86) return this.#v86;
    if (MACHINE.libPath.endsWith('.js')) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = MACHINE.libPath.replace(/\.mjs$/, '.js');
        s.onload = res; s.onerror = () => rej(new Error('Could not load the emulator.'));
        document.head.append(s);
      });
      this.#v86 = window.V86;
    } else {
      try {
        const mod = await import(/* @vite-ignore */ MACHINE.libPath);
        this.#v86 = mod.V86 ?? mod.default?.V86 ?? window.V86;
      } catch {
        // Older builds ship a classic script that assigns window.V86.
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = MACHINE.libPath.replace(/\.mjs$/, '.js');
          s.onload = res; s.onerror = () => rej(new Error('Could not load the emulator.'));
          document.head.append(s);
        });
        this.#v86 = window.V86;
      }
    }
    if (!this.#v86) {
      throw new Error(
        'The emulator is missing. Run tools/fetch-vendor.sh to place v86 in vendor/, ' +
        'or point MACHINE.libPath at your own copy.'
      );
    }
    return this.#v86;
  }

  /**
   * Assemble and start a machine from a resolved floe or base image.
   * `source` must expose { baseFS, readByHash, id }.
   */
  async thaw(source, { identity, screen, onStage, warm = null } = {}) {
    if (this.emulator) await this.scuttle({ silent: true });
    this.source = source;
    this.identity = identity ?? null;
    this.#set('thawing');
    const stage = (s, d) => { onStage?.(s, d); this.emit('stage', { stage: s, ...d }); };

    installVirtualOrigin();
    setHandler(async (path) => {
      // v86 asks for `<baseurl><content-hash>`; that is the entire protocol.
      const hash = path.split('/').pop();
      try { return await source.readByHash(hash); }
      catch (e) { this.emit('fault', { hash, message: e.message }); return null; }
    });

    const V86 = await this.#loadV86();
    stage('assembling', { label: 'Assembling the machine' });
    const basefsUrl = URL.createObjectURL(new Blob([
      JSON.stringify(source.baseFS),
    ], { type: 'application/json' }));

    const options = {
      wasm_path: MACHINE.wasmPath,
      memory_size: MACHINE.memoryMB * 1024 * 1024,
      vga_memory_size: MACHINE.vgaMemoryMB * 1024 * 1024,
      filesystem: { basefs: basefsUrl, baseurl: `${VIRTUAL_ORIGIN}/f/` },
      bzimage_initrd_from_filesystem: true,
      cmdline: this.#cmdline(),
      autostart: false,
      disable_keyboard: false,
      disable_mouse: true,
      screen_container: screen ?? undefined,
      network_relay_url: this.relayUrl ?? undefined,
    };

    this.emulator = new V86(options);
    this.fs = null;
    this.bootedAt = Date.now();

    const ready = new Deferred();
    const onReady = () => ready.resolve();
    this.emulator.add_listener('emulator-ready', onReady);
    this.emulator.add_listener('serial0-output-byte', (b) => this.#serial(b));
    this.emulator.add_listener('emulator-stopped', () => this.emit('stopped'));

    try {
      await Promise.race([ready.promise, sleep(30_000).then(() => {
        throw new Error('The machine did not come up. The emulator may have failed to load its WebAssembly.');
      })]);
    } finally {
      URL.revokeObjectURL(basefsUrl);
    }

    try { this.fs = new GuestFS(this.emulator); } catch (e) { this.emit('fault', { message: e.message }); }

    if (warm) {
      stage('restoring', { label: 'Restoring memory' });
      await this.emulator.restore_state(warm.buffer ?? warm);
      this.emulator.run();
      this.#set('running');
      this.emit('resumed', { warm: true });
    } else {
      stage('booting', { label: 'Starting Alpine' });
      this.#set('booting');
      this.emulator.run();
      this.#waitForPrompt().then((ok) => {
        if (!ok) {
          const output = this.serialBuffer.trim();
          this.#set('failed', { reason: 'shell-timeout' });
          this.emit('fault', {
            message: output
              ? `Alpine did not reach a shell. Last boot output:\n${output}`
              : 'Alpine did not reach a shell and produced no serial output. Check the kernel and initramfs in the base image.',
          });
          return;
        }
        if (this.state === 'booting') this.#set('running');
        this.emit('booted', { ms: Date.now() - this.bootedAt });
      }).catch((e) => {
        this.#set('failed', { reason: 'shell-error' });
        this.emit('fault', { message: `The shell check failed: ${e.message}` });
      });
    }

    this.#armSleep();
    return this;
  }

  #cmdline() {
    const parts = [
      'rw', 'root=host9p', 'rootfstype=9p',
      'rootflags=trans=virtio,cache=loose', 'modules=virtio_pci',
      'console=ttyS0,115200', 'earlyprintk=serial,ttyS0,115200', 'tsc=reliable',
    ];
    return parts.join(' ');
  }

  /* ---------------------------------------------------------------- */
  /* serial                                                            */
  /* ---------------------------------------------------------------- */

  #serial(byte) {
    const ch = String.fromCharCode(byte);
    this.serialBuffer += ch;
    if (this.serialBuffer.length > 4096) this.serialBuffer = this.serialBuffer.slice(-2048);
    this.emit('serial', ch);
  }

  send(text) {
    this.note();
    if (this.state === 'awash') this.wake();
    this.emulator?.serial0_send(text);
  }

  async #waitForPrompt(timeout = 90_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (/[#$] $/.test(this.serialBuffer) || /login:\s*$/.test(this.serialBuffer)) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * Run one command and collect its output. Used by setup and by the editor's
   * run button — never by anything the guest can trigger.
   */
  async run(command, { timeout = 120_000 } = {}) {
    if (!this.emulator) throw new Error('The machine is not running.');
    await this.wake();
    const marker = `__berg_${Math.random().toString(36).slice(2, 8)}__`;
    let out = '';
    const off = this.on('serial', (ch) => { out += ch; });
    this.emulator.serial0_send(`${command}; echo ${marker}$?\n`);
    const started = Date.now();
    const re = new RegExp(`${marker}(\\d+)`);
    while (Date.now() - started < timeout) {
      const m = out.match(re);
      if (m) {
        off();
        const body = out.slice(0, out.indexOf(marker)).replace(/^.*?\n/, '');
        return { code: Number(m[1]), output: body.replace(/\r/g, '') };
      }
      await sleep(80);
    }
    off();
    throw new Error(`“${command}” did not finish within ${Math.round(timeout / 1000)}s.`);
  }

  /* ---------------------------------------------------------------- */
  /* sleep and wake                                                    */
  /* ---------------------------------------------------------------- */

  note() {
    this.lastActivity = Date.now();
    this.#armSleep();
  }

  #armSleep() {
    clearTimeout(this.#awashTimer);
    clearTimeout(this.#submergedTimer);
    if (!this.awake) return;
    this.#awashTimer = setTimeout(() => this.park('awash for a while'), MACHINE.awashAfterMs);
    this.#submergedTimer = setTimeout(() => this.deepen('awash for a long while'), MACHINE.submergedAfterMs);
  }

  /** Park the run loop. Instant both ways; the guest cannot tell. */
  park(reason = '') {
    if (this.state !== 'running' && this.state !== 'booting') return false;
    this.emulator.stop();
    this.#set('awash', { reason });
    return true;
  }

  /** Write memory to local storage and tear the emulator down. */
  async deepen(reason = '') {
    if (this.state === 'submerged' || !this.emulator) return false;
    if (this.state === 'calving') return false;
    const wasRunning = this.awake;
    if (wasRunning) this.emulator.stop();
    this.emit('stage', { stage: 'submerged', label: 'Putting the machine into submerged' });
    try {
      const buf = await this.emulator.save_state();
      await idb.set('session', 'submerged:image', buf);
      await idb.set('session', 'submerged:meta', {
        at: new Date().toISOString(),
        sourceId: this.source?.id ?? null,
        floeId: this.floeId ?? null,
        memoryMB: MACHINE.memoryMB,
        reason,
      });
      this.emulator.destroy?.();
      this.emulator = null;
      this.#set('submerged', { reason });
      return true;
    } catch (e) {
      // Failing to reach submerged is not fatal — stay parked and say so.
      this.emit('fault', { message: `Could not reach submerged: ${e.message}. The machine is parked instead.` });
      this.#set('awash');
      return false;
    }
  }

  /** Bring the machine back from whichever depth it is at. */
  async wake() {
    if (this.awake) { this.note(); return true; }

    if (this.state === 'awash') {
      this.emulator.run();
      this.#set('running');
      this.note();
      this.emit('woke', { from: 'awash', ms: 0 });
      return true;
    }

    if (this.state === 'submerged') {
      const started = Date.now();
      const buf = await idb.get('session', 'submerged:image');
      if (!buf) throw new Error('The submerged image is gone. The session cannot be brought back.');
      this.emit('stage', { stage: 'waking', label: 'Waking the machine' });
      await this.thaw(this.source, { identity: this.identity, screen: this.screen, warm: buf });
      this.emit('woke', { from: 'submerged', ms: Date.now() - started });
      return true;
    }

    return false;
  }

  /** Bytes for a warm floe. The machine is parked first so the image is coherent. */
  async warmImage() {
    if (!this.emulator) throw new Error('There is no running machine to capture.');
    const wasRunning = this.state === 'running';
    this.emulator.stop();
    try {
      const buf = await this.emulator.save_state();
      return new Uint8Array(buf);
    } finally {
      if (wasRunning) { this.emulator.run(); this.#set('running'); }
    }
  }

  /* ---------------------------------------------------------------- */
  /* shutdown                                                          */
  /* ---------------------------------------------------------------- */

  async scuttle({ silent = false } = {}) {
    clearTimeout(this.#awashTimer);
    clearTimeout(this.#submergedTimer);
    try { this.emulator?.stop(); } catch { /* already gone */ }
    try { this.emulator?.destroy?.(); } catch { /* already gone */ }
    this.emulator = null;
    this.fs = null;
    await idb.del('session', 'submerged:image').catch(() => {});
    await idb.del('session', 'submerged:meta').catch(() => {});
    if (!silent) this.#set('scuttled');
    else this.state = 'cold';
  }

  /* ---------------------------------------------------------------- */
  /* recovery                                                          */
  /* ---------------------------------------------------------------- */

  static async submergedAvailable() {
    const meta = await idb.get('session', 'submerged:meta');
    const img = await idb.get('session', 'submerged:image');
    if (!meta || !img) return null;
    return { ...meta, bytes: img.byteLength ?? img.length ?? 0 };
  }

  static async discardSubmerged() {
    await idb.del('session', 'submerged:image').catch(() => {});
    await idb.del('session', 'submerged:meta').catch(() => {});
  }
}

export const machine = new Machine();
