/* ICEBERG — the terminal.
 *
 * xterm.js on the serial line. The desktop half is unremarkable and should be:
 * a terminal that behaves like a terminal. The mobile half is the work.
 *
 * A phone keyboard has no Ctrl, no Esc, no Tab, no arrows, and no pipe without
 * three taps. So there is a key rail above the keyboard with the characters a
 * shell actually needs, a history strip you can reach with a thumb, and a
 * layout that holds when the keyboard takes half the screen.
 */

import { el, $ } from '../util.js';
import { idb } from '../idb.js';

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm';
const FIT_JS = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm';

const KEYS = [
  { label: 'esc', send: '\x1b' },
  { label: 'tab', send: '\t' },
  { label: 'ctrl', mod: 'ctrl' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '↑', send: '\x1b[A' },
  { label: '↓', send: '\x1b[B' },
  { label: '←', send: '\x1b[D' },
  { label: '→', send: '\x1b[C' },
];

export class Terminal {
  term = null;
  fit = null;
  #machine;
  #history = [];
  #line = '';
  #ctrl = false;
  #strip = null;        // the history chip row (mobile)
  #railNode = null;     // the key rail (mobile)

  constructor(machine) { this.#machine = machine; }

  async mount(container) {
    if (!document.querySelector(`link[href="${XTERM_CSS}"]`)) {
      document.head.append(el('link', { rel: 'stylesheet', href: XTERM_CSS }));
    }
    const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import(XTERM_JS), import(FIT_JS)]);

    const screen = el('div', { class: 'term__screen' });
    const rail = this.#buildRail();
    const strip = this.#strip = el('div', { class: 'term__history mono' });
    container.append(strip, screen, rail);

    this.term = new XTerm({
      fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
      fontSize: window.innerWidth < 700 ? 12 : 13.5,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 4000,
      allowProposedApi: true,
      theme: {
        background: '#02050a',
        foreground: '#d8e8f7',
        cursor: '#7fe3ff',
        selectionBackground: 'rgba(127,227,255,.28)',
        black: '#0b131f', red: '#ff6b4a', green: '#6ee7b7', yellow: '#ffa24c',
        blue: '#7fe3ff', magenta: '#a98bff', cyan: '#7fe3ff', white: '#e9f3ff',
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(screen);
    this.#resize();

    this.term.onData((data) => this.#input(data));
    this.#machine.on('serial', (ch) => this.term.write(ch));

    new ResizeObserver(() => this.#resize()).observe(screen);
    window.visualViewport?.addEventListener('resize', () => this.#resize());

    this.#history = (await idb.get('meta', 'history')) ?? [];
    this.#renderStrip();
    return this;
  }

  #resize() {
    try { this.fit?.fit(); } catch { /* container not laid out yet */ }
  }

  focus() { this.term?.focus(); this.#resize(); }

  write(text) { this.term?.write(text); }

  #input(data) {
    if (this.#ctrl && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0) - 64;
      if (code > 0 && code < 32) data = String.fromCharCode(code);
      this.#ctrl = false;
      this.#railNode?.querySelector('[data-mod=ctrl]')?.classList.remove('on');
    }
    // Track the current line only to build the history strip; the shell owns
    // the real editing.
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { this.#remember(this.#line.trim()); this.#line = ''; }
      else if (ch === '\x7f') this.#line = this.#line.slice(0, -1);
      else if (ch >= ' ') this.#line += ch;
    }
    this.#machine.send(data);
  }

  #remember(cmd) {
    if (!cmd || cmd.length > 200) return;
    this.#history = [cmd, ...this.#history.filter((c) => c !== cmd)].slice(0, 40);
    idb.set('meta', 'history', this.#history).catch(() => {});
    this.#renderStrip();
  }

  #renderStrip() {
    if (!this.#strip) return;
    this.#strip.replaceChildren(...this.#history.slice(0, 14).map((cmd) =>
      el('button', {
        class: 'chip',
        title: cmd,
        onclick: () => { this.#machine.send(cmd); this.focus(); },
      }, cmd.length > 26 ? `${cmd.slice(0, 25)}…` : cmd)));
    this.#strip.hidden = this.#history.length === 0;
  }

  #buildRail() {
    const rail = this.#railNode = el('div', { class: 'term__rail mono', role: 'toolbar', 'aria-label': 'Terminal keys' });
    for (const k of KEYS) {
      rail.append(el('button', {
        class: 'key',
        dataset: k.mod ? { mod: k.mod } : {},
        onpointerdown: (e) => {
          e.preventDefault();
          if (k.mod) {
            this.#ctrl = !this.#ctrl;
            e.currentTarget.classList.toggle('on', this.#ctrl);
          } else {
            this.#input(k.send);
          }
          this.focus();
        },
      }, k.label));
    }
    return rail;
  }

  dispose() { this.term?.dispose(); }
}
