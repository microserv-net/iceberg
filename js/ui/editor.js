/* ICEBERG — the editor.
 *
 * CodeMirror 6 rather than Monaco. Three reasons, in order of weight:
 * it works on touch devices (Monaco's mobile story is an accident, not a
 * feature), it is a fifth of the payload on a phone connection, and it does not
 * require a web worker per language just to open a file.
 *
 * The editor is not a program running inside Alpine. It is browser-side, and it
 * reads and writes the 9p filesystem directly — which is why it keeps working
 * with the machine's processor completely parked, and why opening a file does
 * not wake anything up.
 */

import { el } from '../util.js';
import { notify, fail } from './dialog.js';

const CM = 'https://cdn.jsdelivr.net/npm/codemirror@6.0.1/+esm';
const VIEW = 'https://cdn.jsdelivr.net/npm/@codemirror/view@6.34.1/+esm';
const STATE = 'https://cdn.jsdelivr.net/npm/@codemirror/state@6.4.1/+esm';
const ONEDARK = 'https://cdn.jsdelivr.net/npm/@codemirror/theme-one-dark@6.1.2/+esm';
const LANGS = {
  js: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.2.2/+esm',
  rust: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-rust@6.0.1/+esm',
  python: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-python@6.1.6/+esm',
  html: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-html@6.4.9/+esm',
  css: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-css@6.3.0/+esm',
  json: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-json@6.0.1/+esm',
  markdown: 'https://cdn.jsdelivr.net/npm/@codemirror/lang-markdown@6.3.0/+esm',
};

const EXT = {
  '.rs': 'rust', '.js': 'js', '.mjs': 'js', '.ts': 'js', '.jsx': 'js', '.tsx': 'js',
  '.py': 'python', '.html': 'html', '.htm': 'html', '.css': 'css',
  '.json': 'json', '.md': 'markdown',
};

export class Editor {
  view = null;
  path = null;
  dirty = false;
  #fs;
  #onRun;
  #host;
  #title;
  #saveBtn;

  constructor(fs, { onRun } = {}) { this.#fs = fs; this.#onRun = onRun; }

  setFS(fs) { this.#fs = fs; }

  async mount(container) {
    this.#title = el('span', { class: 'editor__path mono' }, 'No file open');
    this.#saveBtn = el('button', { class: 'btn btn--sm', disabled: true, onclick: () => this.save() }, 'Save');
    const runBtn = el('button', {
      class: 'btn btn--sm btn--warm',
      onclick: () => this.#onRun?.(this.path),
      title: 'Runs in the machine, which wakes it',
    }, 'Run');

    const bar = el('div', { class: 'editor__bar' },
      this.#title, el('span', { class: 'spacer' }), this.#saveBtn, runBtn);
    this.#host = el('div', { class: 'editor__host' });
    container.append(bar, this.#host);

    const [{ EditorView, keymap, lineNumbers, highlightActiveLine }, { EditorState },
           { basicSetup }, { oneDark }] = await Promise.all([
      import(VIEW), import(STATE), import(CM), import(ONEDARK),
    ]);
    this.#lib = { EditorView, EditorState, basicSetup, oneDark, keymap };

    this.#empty();
    return this;
  }

  #empty() {
    this.#host.replaceChildren(el('div', { class: 'editor__empty' },
      el('p', {}, 'Pick a file on the left to open it.'),
      el('p', { class: 'muted small' },
        'The editor reads the machine\u2019s filesystem directly. Opening and saving ' +
        'files does not wake the processor \u2014 only running something does.')));
  }

  async open(path) {
    if (this.dirty && !(await this.#confirmDiscard())) return;
    const { EditorView, EditorState, basicSetup, oneDark } = this.#lib;

    let text;
    try { text = await this.#fs.readText(path); }
    catch (e) { fail(e); return; }

    const ext = Object.entries(EXT).find(([e]) => path.endsWith(e))?.[1];
    const lang = ext ? await import(LANGS[ext]).then((m) => (m[ext === 'js' ? 'javascript' : ext]?.() ?? [])).catch(() => []) : [];

    this.view?.destroy();
    this.#host.replaceChildren();
    this.view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup, oneDark, lang,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => { if (u.docChanged) this.#markDirty(true); }),
          EditorView.theme({
            '&': { height: '100%', fontSize: window.innerWidth < 700 ? '12.5px' : '13.5px' },
            '.cm-scroller': { fontFamily: 'IBM Plex Mono, ui-monospace, monospace' },
            '.cm-gutters': { background: 'transparent', borderRight: '1px solid rgba(127,227,255,.1)' },
          }),
        ],
      }),
      parent: this.#host,
    });

    this.path = path;
    this.#title.textContent = path;
    this.#markDirty(false);
  }

  #markDirty(v) {
    this.dirty = v;
    this.#saveBtn.disabled = !v;
    this.#title.dataset.dirty = v ? '1' : '';
  }

  async save() {
    if (!this.view || !this.path) return;
    const text = this.view.state.doc.toString();
    try {
      await this.#fs.write(this.path, text);
      this.#markDirty(false);
      notify(`${this.path} written to the machine. It is drift until you calve.`, { title: 'Saved', tone: 'warm' });
    } catch (e) { fail(e); }
  }

  async #confirmDiscard() {
    const { confirm } = await import('./dialog.js');
    return confirm({
      title: 'Unsaved edits',
      body: [`${this.path} has changes that are not written to the machine yet.`],
      confirmLabel: 'Discard them',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
  }

  dispose() { this.view?.destroy(); this.view = null; }
}
