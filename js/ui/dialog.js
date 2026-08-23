/* ICEBERG — dialogs and notices.
 *
 * Destructive actions name what is lost, in the same words the rest of the
 * interface uses. A button that says Calve produces a notice that says Calved.
 */

import { el, $ } from '../util.js';

function host() {
  let h = document.getElementById('toasts');
  if (!h) { h = el('div', { id: 'toasts' }); document.body.append(h); }
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && h.parentElement !== openDialog) openDialog.append(h);
  return h;
}

export function notify(message, { title = null, tone = 'cold', ms = 5200 } = {}) {
  const node = el('div', { class: 'toast', dataset: { tone }, role: 'status' },
    title ? el('strong', {}, title) : null,
    message);
  host().append(node);
  const kill = () => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 320);
  };
  const t = setTimeout(kill, ms);
  node.addEventListener('click', () => { clearTimeout(t); kill(); });
  return kill;
}

export const fail = (e) => notify(e?.message ?? String(e), { title: 'Stopped', tone: 'bad', ms: 9000 });

/* ------------------------------------------------------------------ */

function sheet(build) {
  const dlg = el('dialog', { class: 'sheet' });
  const panel = el('div', { class: 'panel' });
  dlg.append(panel);
  document.body.append(dlg);

  const close = (value) => {
    dlg.close();
    dlg.remove();
    return value;
  };

  return new Promise((resolve) => {
    build(panel, (v) => resolve(close(v)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); resolve(close(null)); });
    dlg.showModal();
    const first = panel.querySelector('input, button:not([data-secondary])');
    first?.focus();
  });
}

export function confirm({
  title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel',
  tone = 'cold', detail = null, requireText = null,
}) {
  return sheet((panel, done) => {
    panel.append(el('h3', {}, title));
    for (const line of [].concat(body)) panel.append(el('p', { class: 'muted' }, line));
    if (detail) {
      panel.append(el('ul', { class: 'detail mono' }, detail.map((d) => el('li', {}, d))));
    }

    let input = null;
    if (requireText) {
      input = el('input', { type: 'text', placeholder: requireText, autocomplete: 'off', spellcheck: false });
      panel.append(el('label', { class: 'field' },
        el('span', {}, `Type ${requireText} to confirm`), input));
    }

    const go = el('button', {
      class: `btn ${tone === 'danger' ? 'btn--danger' : tone === 'warm' ? 'btn--warm' : 'btn--cold'}`,
      disabled: !!requireText,
      onclick: () => done(true),
    }, confirmLabel);

    input?.addEventListener('input', () => { go.disabled = input.value.trim() !== requireText; });

    panel.append(el('div', { class: 'row', style: { marginTop: '1.3rem', justifyContent: 'flex-end' } },
      el('button', { class: 'btn btn--ghost', 'data-secondary': '1', onclick: () => done(false) }, cancelLabel),
      go));
  });
}

export function choose({ title, body, options }) {
  return sheet((panel, done) => {
    panel.append(el('h3', {}, title));
    for (const line of [].concat(body ?? [])) panel.append(el('p', { class: 'muted' }, line));
    const list = el('div', { class: 'choices' });
    for (const opt of options) {
      list.append(el('button', {
        class: `choice ${opt.tone ? `choice--${opt.tone}` : ''}`,
        onclick: () => done(opt.value),
      },
        el('b', {}, opt.label),
        opt.hint ? el('em', {}, opt.hint) : null));
    }
    panel.append(list);
    panel.append(el('div', { class: 'row', style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      el('button', { class: 'btn btn--ghost', 'data-secondary': '1', onclick: () => done(null) }, 'Cancel')));
  });
}

export function ask({
  title, body, label, placeholder = '', value = '', confirmLabel = 'Save',
  validate = null, extra = null,
}) {
  return sheet((panel, done) => {
    panel.append(el('h3', {}, title));
    for (const line of [].concat(body ?? [])) panel.append(el('p', { class: 'muted' }, line));

    const input = el('input', { type: 'text', placeholder, value, autocomplete: 'off', spellcheck: false });
    const why = el('p', { class: 'why' });
    panel.append(el('label', { class: 'field' }, el('span', {}, label), input, why));

    let extraState = {};
    if (extra) extraState = extra(panel);

    const go = el('button', {
      class: 'btn btn--cold',
      onclick: () => done({ value: input.value.trim(), ...(extraState.read?.() ?? {}) }),
    }, confirmLabel);

    const check = () => {
      if (!validate) { go.disabled = !input.value.trim(); why.textContent = ''; return; }
      const v = validate(input.value);
      go.disabled = !v.ok;
      why.textContent = v.ok ? '' : (v.why ?? '');
      why.dataset.tone = v.ok ? 'ok' : 'bad';
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
    check();

    panel.append(el('div', { class: 'row', style: { marginTop: '1.3rem', justifyContent: 'flex-end' } },
      el('button', { class: 'btn btn--ghost', 'data-secondary': '1', onclick: () => done(null) }, 'Cancel'),
      go));
  });
}

/* A progress sheet that cannot be dismissed while work is in flight. */
export function progress({ title, subtitle = '' }) {
  const dlg = el('dialog', { class: 'sheet' });
  const bar = el('i');
  const label = el('p', { class: 'mono small muted' }, subtitle);
  const stat = el('p', { class: 'mono small' });
  const panel = el('div', { class: 'panel' },
    el('h3', {}, title),
    label,
    el('div', { class: 'progress' }, bar),
    stat);
  dlg.append(panel);
  document.body.append(dlg);
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.showModal();

  return {
    step(text, { done, total, note } = {}) {
      label.textContent = text;
      if (total) {
        bar.style.width = `${Math.min(100, (done / total) * 100).toFixed(1)}%`;
        bar.dataset.indeterminate = '';
        stat.textContent = note ?? `${done} / ${total}`;
      } else {
        bar.dataset.indeterminate = '1';
        stat.textContent = note ?? '';
      }
    },
    close() { dlg.close(); dlg.remove(); },
  };
}
