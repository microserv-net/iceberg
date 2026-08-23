/* ICEBERG — the file pane.
 *
 * A tree over the guest's real filesystem. Entries that have drifted since the
 * thaw are marked warm, so you can see what you would be calving without
 * opening a dialog to find out.
 */

import { el, bytesHuman, dirname } from '../util.js';
import { fail, ask, confirm } from './dialog.js';

export class FileTree {
  #fs;
  #root;
  #host;
  #open = new Set(['/', '/root']);
  #drift = new Set();
  onOpen = null;

  constructor(fs, { start = '/root' } = {}) { this.#fs = fs; this.#start = start; }

  setFS(fs) { this.#fs = fs; }

  async mount(container) {
    const bar = el('div', { class: 'files__bar' },
      el('span', { class: 'mono small muted' }, 'FILES'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn--ghost btn--sm', title: 'New file', onclick: () => this.#newFile() }, '+ file'),
      el('button', { class: 'btn btn--ghost btn--sm', title: 'Refresh', onclick: () => this.refresh() }, '↻'));
    this.#host = el('div', { class: 'files__tree' });
    container.append(bar, this.#host);
    await this.refresh();
    return this;
  }

  markDrift(drift) {
    this.#drift = new Set([...drift.added, ...drift.changed]);
    // Light-touch: repaint marks without rebuilding the tree.
    for (const node of this.#host.querySelectorAll('[data-path]')) {
      node.dataset.drift = this.#drift.has(node.dataset.path) ? '1' : '';
    }
  }

  async refresh() {
    if (!this.#fs) return;
    const frag = document.createDocumentFragment();
    try {
      await this.#render('/', frag, 0);
    } catch (e) {
      frag.append(el('p', { class: 'muted small' }, e.message));
    }
    this.#host.replaceChildren(frag);
  }

  async #render(path, parent, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await this.#fs.list(path); } catch { return; }

    for (const e of entries) {
      const isOpen = this.#open.has(e.path);
      const row = el('button', {
        class: `file file--${e.kind}`,
        dataset: { path: e.path, drift: this.#drift.has(e.path) ? '1' : '' },
        style: { paddingLeft: `${depth * 12 + 10}px` },
        onclick: () => this.#click(e),
        oncontextmenu: (ev) => { ev.preventDefault(); this.#menu(e); },
      },
        el('span', { class: 'file__icon' }, e.kind === 'dir' ? (isOpen ? '▾' : '▸') : e.kind === 'link' ? '↳' : '·'),
        el('span', { class: 'file__name' }, e.name),
        e.kind === 'file' ? el('span', { class: 'file__size mono' }, bytesHuman(e.size)) : null);
      parent.append(row);

      if (e.kind === 'dir' && isOpen) {
        const box = el('div', { class: 'file__children' });
        parent.append(box);
        await this.#render(e.path, box, depth + 1);
      }
    }
  }

  async #click(entry) {
    if (entry.kind === 'dir') {
      if (this.#open.has(entry.path)) this.#open.delete(entry.path);
      else this.#open.add(entry.path);
      await this.refresh();
    } else {
      this.onOpen?.(entry.path);
    }
  }

  async #menu(entry) {
    const { choose } = await import('./dialog.js');
    const action = await choose({
      title: entry.name,
      body: [entry.path],
      options: [
        { label: 'Open', value: 'open' },
        { label: 'Rename', value: 'rename' },
        { label: 'Delete', value: 'delete', tone: 'danger', hint: 'From this session only' },
      ],
    });
    if (action === 'open') this.onOpen?.(entry.path);
    if (action === 'rename') await this.#rename(entry);
    if (action === 'delete') await this.#delete(entry);
  }

  async #rename(entry) {
    const res = await ask({
      title: 'Rename',
      label: 'New name',
      value: entry.name,
      confirmLabel: 'Rename',
      validate: (v) => v.trim() && !v.includes('/') ? { ok: true } : { ok: false, why: 'A name, not a path.' },
    });
    if (!res) return;
    try {
      const data = await this.#fs.read(entry.path);
      await this.#fs.write(`${dirname(entry.path)}/${res.value}`, data);
      await this.#fs.unlink(entry.path);
      await this.refresh();
    } catch (e) { fail(e); }
  }

  async #delete(entry) {
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      body: [
        'This removes it from the running machine only.',
        'The floe you thawed from still has it, and always will.',
      ],
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try { await this.#fs.unlink(entry.path); await this.refresh(); }
    catch (e) { fail(e); }
  }

  async #newFile() {
    const res = await ask({
      title: 'New file',
      label: 'Path',
      placeholder: '/root/project/main.rs',
      value: '/root/',
      confirmLabel: 'Create',
      validate: (v) => v.trim().startsWith('/') ? { ok: true } : { ok: false, why: 'Start at the root: /root/…' },
    });
    if (!res) return;
    try {
      await this.#fs.write(res.value, '');
      this.#open.add(dirname(res.value));
      await this.refresh();
      this.onOpen?.(res.value);
    } catch (e) { fail(e); }
  }
}
