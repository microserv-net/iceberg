/* ICEBERG — the machine.
 *
 * Four screens, in the order a first-time user meets them:
 *   gate     sign in with a key you make yourself
 *   shelf    your floes, and the machine's state
 *   setup    the first run, once
 *   work     the machine itself
 *
 * The landing page is loud. This is not. Everything here is either the machine
 * or a fact about it.
 */

import { APP, BASE_NAME, IMAGES, MACHINE } from '../config.js';
import { el, $, bytesHuman, ago, duration, sleep, esc } from '../util.js';
import { gh, events as ghEvents } from '../github.js';
import * as Auth from '../auth.js';
import * as Vault from '../vault.js';
import * as Floes from '../floes.js';
import { session } from '../session.js';
import { machine, Machine } from '../machine.js';
import { loadImage } from '../image.js';
import { Terminal } from './terminal.js';
import { Editor } from './editor.js';
import { FileTree } from './files.js';
import { notify, fail, confirm, ask, choose, progress } from './dialog.js';

const app = $('#app');
const ribbon = $('#ribbon');

/* ------------------------------------------------------------------ */
/* status ribbon — the one thing on screen at all times                */
/* ------------------------------------------------------------------ */

const TONE = {
  cold: 'cold', thawing: 'sleep', booting: 'warm', running: 'warm',
  awash: 'sleep', submerged: 'sleep', calving: 'cold', scuttled: 'cold', failed: 'bad',
};
const SAYS = {
  cold: 'No machine', thawing: 'Thawing', booting: 'Starting', running: 'Running',
  awash: 'Awash', submerged: 'Submerged', calving: 'Calving', scuttled: 'Scuttled', failed: 'Stopped',
};

function paintRibbon() {
  if (!ribbon) return;
  const state = machine.state;
  const drift = session.drift;
  ribbon.replaceChildren(
    el('a', { class: 'wordmark', href: './', 'aria-label': 'Iceberg' },
      el('span', {}, 'ICEBERG')),
    el('span', { class: 'pill', dataset: { tone: TONE[state] ?? 'cold' } }, SAYS[state] ?? state),
    session.floeName
      ? el('span', { class: 'ribbon__name mono' }, session.floeName)
      : null,
    drift.count
      ? el('span', { class: 'ribbon__drift mono', title: session.describeDrift() },
          `${drift.count} ${drift.count === 1 ? 'change' : 'changes'} · ${bytesHuman(drift.bytes)}`)
      : machine.emulator ? el('span', { class: 'ribbon__drift mono clean' }, 'no drift') : null,
    el('span', { class: 'spacer' }),
    machine.emulator ? el('button', {
      class: 'btn btn--cold btn--sm', onclick: calveFlow,
    }, 'Calve') : null,
    el('button', { class: 'btn btn--ghost btn--sm', onclick: menu, 'aria-label': 'Menu' }, '⋯'),
  );
}

machine.on('state', paintRibbon);
session.on('drift', paintRibbon);
session.on('began', paintRibbon);
session.on('warning', (w) => notify(w.message, { title: 'Worth knowing', tone: 'warm', ms: 9000 }));
machine.on('fault', (f) => notify(f.message, { title: 'Machine', tone: 'bad', ms: 8000 }));
ghEvents.on('rate', (r) => {
  if (r.remaining != null && r.remaining < 250) {
    notify(`GitHub API budget is down to ${r.remaining}. It refills at ${new Date(r.reset).toLocaleTimeString()}.`,
      { title: 'Slowing down', tone: 'warm', ms: 9000 });
  }
});

/* ------------------------------------------------------------------ */
/* screen: the gate                                                    */
/* ------------------------------------------------------------------ */

async function gate({ reason = null } = {}) {
  const remembered = await Auth.hasRemembered().catch(() => false);
  const rememberedFor = remembered ? await Auth.rememberedLogin() : null;

  const key = el('input', {
    type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: false,
    id: 'vault-key',
  });
  const remember = el('input', { type: 'checkbox', id: 'remember' });
  const pass = el('input', { type: 'password', placeholder: 'passphrase for this device', disabled: true });
  remember.addEventListener('change', () => { pass.disabled = !remember.checked; });

  const go = el('button', { class: 'btn btn--cold', onclick: submit }, 'Unlock the vault');

  async function submit() {
    go.disabled = true;
    const original = go.textContent;
    go.textContent = 'Checking…';
    try {
      await Auth.signInWithKey(key.value, { remember: remember.checked ? pass.value : null });
      await afterSignIn();
    } catch (e) {
      fail(e);
      go.disabled = false;
      go.textContent = original;
    }
  }

  const permTable = el('table', { class: 'perms' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Permission'), el('th', {}, 'Level'), el('th', {}, 'Why'))),
    el('tbody', {}, Auth.PERMISSIONS.map((p) => el('tr', {},
      el('td', { class: 'mono' }, p.name), el('td', {}, p.level), el('td', { class: 'muted' }, p.why)))));

  app.replaceChildren(el('div', { class: 'gate' },
    el('div', { class: 'panel gate__card' },
      el('p', { class: 'eyebrow' }, 'Sign in'),
      el('h2', {}, 'Your vault key'),
      reason ? el('p', { class: 'notice' }, reason) : null,
      el('p', { class: 'muted' },
        'Iceberg has no accounts and no server. You create a GitHub token scoped to ' +
        'your own account, and it never leaves this tab except as a header to api.github.com.'),

      remembered ? el('div', { class: 'remembered' },
        el('p', {}, `A key for ${rememberedFor ?? 'this device'} is stored here, wrapped with a passphrase.`),
        el('div', { class: 'row' },
          el('input', { type: 'password', placeholder: 'passphrase', id: 'unlock-pass',
            onkeydown: (e) => { if (e.key === 'Enter') $('#unlock-btn').click(); } }),
          el('button', {
            class: 'btn btn--cold', id: 'unlock-btn',
            onclick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              try { await Auth.unlockRemembered($('#unlock-pass').value); await afterSignIn(); }
              catch (e) { fail(e); btn.disabled = false; }
            },
          }, 'Unlock')),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onclick: async () => { await Auth.forgetDevice(); gate(); },
        }, 'Forget this device'),
        el('hr', { class: 'rule' })) : null,

      el('ol', { class: 'steps' },
        el('li', {},
          el('a', { class: 'btn btn--sm', href: Auth.tokenCreationUrl(), target: '_blank', rel: 'noopener' },
            'Open GitHub\u2019s token page ↗'),
          el('span', { class: 'muted small' }, ' Fine-grained, your own account, 90 days is plenty.')),
        el('li', {}, 'Give it these three permissions and nothing else:', permTable),
        el('li', {}, 'Paste it here:',
          el('div', { class: 'row', style: { marginTop: '.6rem' } }, key, go),
          el('label', { class: 'check' }, remember, ' Remember it on this device'),
          pass)),

      el('details', { class: 'aside' },
        el('summary', {}, 'What Iceberg deliberately does not ask for'),
        el('p', { class: 'muted small' }, Auth.NOT_REQUESTED.join(' · ')),
        el('p', { class: 'muted small' },
          'On first use the key has to cover your whole account, because the vault ' +
          'repository does not exist yet. Once it does, narrow the key to ' +
          `${APP.vaultRepo} only — the app will remind you.`)),

      Auth.signInAvailable() ? el('div', { class: 'alt' },
        el('hr', { class: 'rule' }),
        el('button', { class: 'btn', onclick: deviceFlow }, 'Sign in with GitHub instead'),
        el('p', { class: 'muted small' },
          'Uses a device code through this deployment\u2019s stateless relay, because ' +
          'GitHub\u2019s token endpoint refuses browsers.')) : null,
    )));
  key.focus();
}

async function deviceFlow() {
  let flow;
  try { flow = await Auth.startDeviceFlow(); } catch (e) { return fail(e); }
  const p = progress({ title: 'Sign in on GitHub', subtitle: 'Waiting for you to approve this device' });
  p.step(`Enter ${flow.userCode} at ${flow.verificationUri}`);
  window.open(flow.verificationUri, '_blank', 'noopener');
  try {
    await Auth.pollDeviceFlow(flow, { onTick: (left) => p.step(`Code ${flow.userCode} — ${Math.ceil(left / 1000)}s left`) });
    p.close();
    await afterSignIn();
  } catch (e) { p.close(); fail(e); }
}

/* ------------------------------------------------------------------ */
/* provisioning                                                        */
/* ------------------------------------------------------------------ */

async function afterSignIn() {
  const user = Auth.state.user;
  const p = progress({ title: 'Opening your vault', subtitle: `${user.login}/${APP.vaultRepo}` });
  try {
    await Vault.ensureVault(user.login, { onStep: (s, detail) => p.step(detail) });
    await Floes.loadIndex({ force: true });
    p.close();
  } catch (e) {
    p.close();
    return fail(e);
  }

  const submerged = await Machine.submergedAvailable();
  if (submerged) return recoverSubmerged(submerged);
  return shelf();
}

async function recoverSubmerged(submerged) {
  const floe = submerged.floeId ? Floes.byId(submerged.floeId) : null;
  const answer = await choose({
    title: 'There is a machine in submerged',
    body: [
      `Put away ${ago(submerged.at)} — ${bytesHuman(submerged.bytes)} of memory held locally.`,
      floe ? `It was thawed from ${floe.name}.` : 'It was never calved as a floe.',
    ],
    options: [
      { label: 'Wake it', value: 'wake', hint: 'Everything exactly as you left it' },
      { label: 'Leave it and go to the shelf', value: 'shelf', hint: 'Stays in submerged' },
      { label: 'Throw it away', value: 'drop', tone: 'danger', hint: 'Anything uncalved is gone' },
    ],
  });
  if (answer === 'drop') { await Machine.discardSubmerged(); await import('../session.js').then((m) => m.Session.clearSpill()); }
  if (answer === 'wake') {
    try {
      await workspace();
      machine.source = submerged.floeId
        ? await Floes.thaw(submerged.floeId)
        : await loadImage(submerged.sourceId ?? IMAGES.default);
      session.floeId = submerged.floeId;
      session.floeName = floe?.name ?? null;
      machine.state = 'submerged';
      await machine.wake();
      paintRibbon();
      return;
    } catch (e) { fail(e); }
  }
  return shelf();
}

/* ------------------------------------------------------------------ */
/* screen: the shelf                                                   */
/* ------------------------------------------------------------------ */

async function shelf() {
  const list = Floes.list();
  const setup = Floes.setup();
  paintRibbon();

  if (!list.length) return firstRun();

  const card = (c) => {
    const isBase = c.name === BASE_NAME;
    const chain = Floes.lineage(c.id);
    return el('article', { class: `floe ${isBase ? 'floe--base' : ''} panel` },
      el('header', {},
        el('h3', {}, c.name),
        isBase ? el('span', { class: 'pill', dataset: { tone: 'sleep' } }, 'Factory') : null,
        c.warm ? el('span', { class: 'pill', dataset: { tone: 'cold' } }, 'Warm') : null),
      el('p', { class: 'floe__meta mono small' },
        `${ago(c.created)} · ${c.fileCount?.toLocaleString() ?? '—'} files · ${bytesHuman(c.bytes)}`),
      c.note ? el('p', { class: 'floe__note' }, c.note) : null,
      chain.length > 1 ? el('p', { class: 'floe__chain mono small muted' },
        chain.map((x) => x.name).join('  ›  ')) : null,
      el('div', { class: 'row' },
        el('button', { class: 'btn btn--cold btn--sm', onclick: () => thawInto(c.id) }, 'Thaw'),
        el('button', { class: 'btn btn--ghost btn--sm', onclick: () => floeMenu(c) }, '⋯')));
  };

  app.replaceChildren(el('div', { class: 'shelf' },
    el('header', { class: 'shelf__head' },
      el('p', { class: 'eyebrow' }, `${Auth.state.user.login}/${APP.vaultRepo} · private`),
      el('h2', {}, 'Your floes'),
      el('p', { class: 'muted tight' },
        'Each one is a complete machine. Thawing never changes it — everything you do ' +
        'afterwards belongs to the session until you calve.')),
    el('div', { class: 'shelf__grid' }, list.map(card)),
    el('footer', { class: 'shelf__foot' },
      el('button', { class: 'btn btn--ghost btn--sm', onclick: vaultInfo }, 'Vault details'),
      el('button', { class: 'btn btn--ghost btn--sm', onclick: refreshShelf }, 'Check for changes from other devices'),
      el('a', { class: 'btn btn--ghost btn--sm', href: 'docs.html' }, 'Manual'))));
}

async function refreshShelf() {
  try {
    await Vault.refresh();
    await Floes.loadIndex({ force: true });
    notify('The shelf matches GitHub.', { title: 'Up to date', tone: 'ok' });
    shelf();
  } catch (e) { fail(e); }
}

async function floeMenu(c) {
  const isBase = c.name === BASE_NAME;
  const action = await choose({
    title: c.name,
    body: [`Calved ${ago(c.created)}.`],
    options: [
      { label: 'Thaw', value: 'thaw' },
      { label: 'Download everything now', value: 'prefetch', hint: 'So it thaws offline later' },
      !isBase ? { label: 'Rename', value: 'rename' } : null,
      !isBase ? { label: 'Forget', value: 'forget', tone: 'danger', hint: 'Removes it from the shelf' } : null,
    ].filter(Boolean),
  });
  if (action === 'thaw') return thawInto(c.id);
  if (action === 'rename') {
    const res = await ask({
      title: 'Rename floe', label: 'Name', value: c.name, confirmLabel: 'Rename',
      validate: (v) => Floes.checkName(v, { allowId: c.id }),
    });
    if (res) { try { await Floes.rename(c.id, res.value); shelf(); } catch (e) { fail(e); } }
  }
  if (action === 'forget') {
    const ok = await confirm({
      title: `Forget “${c.name}”?`,
      body: [
        'It disappears from the shelf and can no longer be thawed.',
        'Its pieces stay in the repository until GitHub next collects what nothing ' +
        'references — Iceberg cannot force that, and does not pretend to.',
      ],
      detail: [`${c.fileCount?.toLocaleString() ?? '?'} files`, bytesHuman(c.bytes)],
      confirmLabel: 'Forget it',
      tone: 'danger',
      requireText: c.name,
    });
    if (ok) { try { await Floes.forget(c.id); shelf(); } catch (e) { fail(e); } }
  }
  if (action === 'prefetch') {
    const p = progress({ title: `Downloading ${c.name}`, subtitle: 'Every piece, so it thaws without the network' });
    try {
      const r = await Floes.thaw(c.id);
      await r.prefetch(({ done, total }) => p.step('Pulling pieces', { done, total }));
      p.close();
      notify(`${c.name} is held locally.`, { title: 'Downloaded', tone: 'ok' });
    } catch (e) { p.close(); fail(e); }
  }
}

async function vaultInfo() {
  let bytes = null;
  try { bytes = await Vault.vaultSize(); } catch { /* size is a nicety */ }
  const verdict = bytes != null ? Vault.sizeVerdict(bytes) : { level: 'ok', message: null };
  await confirm({
    title: 'Vault',
    body: [
      `${Vault.repo.owner}/${Vault.repo.name} — private.`,
      bytes != null ? `GitHub reports ${bytesHuman(bytes)}.` : 'Size unavailable right now.',
      verdict.message ?? 'Comfortably inside GitHub\u2019s limits.',
      `API budget: ${gh.rate.remaining ?? '—'} of ${gh.rate.limit ?? '—'} calls left this hour.`,
    ],
    confirmLabel: 'Close',
    cancelLabel: 'Sign out',
  }).then((keep) => { if (keep === false) doSignOut(); });
}

async function doSignOut() {
  if (session.dirty) {
    const ok = await confirm({
      title: 'Sign out with drift?',
      body: [session.describeDrift(), 'Signing out ends the session. Uncalved work is lost.'],
      confirmLabel: 'Sign out anyway', tone: 'danger',
    });
    if (!ok) return;
  }
  await session.end({ silent: true });
  await Machine.discardSubmerged();
  Auth.signOut();
  location.reload();
}

/* ------------------------------------------------------------------ */
/* screen: first run                                                   */
/* ------------------------------------------------------------------ */

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function firstRun() {
  const f = {
    username: el('input', { type: 'text', value: 'dev', spellcheck: false, autocomplete: 'off' }),
    hostname: el('input', { type: 'text', value: 'iceberg', spellcheck: false, autocomplete: 'off' }),
    password: el('input', { type: 'password', placeholder: 'for sudo inside the machine', autocomplete: 'new-password' }),
    timezone: el('input', { type: 'text', value: TZ, spellcheck: false }),
    shell: el('select', {}, el('option', { value: 'ash' }, 'ash — Alpine\u2019s own, smallest'), el('option', { value: 'bash' }, 'bash — familiar, a little larger')),
  };

  const go = el('button', { class: 'btn btn--cold', onclick: build }, `Build ${BASE_NAME}`);

  async function build() {
    go.disabled = true;
    const identity = {
      username: f.username.value.trim() || 'dev',
      hostname: f.hostname.value.trim() || 'iceberg',
      password: f.password.value,
      timezone: f.timezone.value.trim() || 'UTC',
      shell: f.shell.value,
      at: new Date().toISOString(),
    };
    const p = progress({ title: `Building ${BASE_NAME}`, subtitle: 'Reading the factory machine' });
    try {
      await workspace({ bare: true });
      await session.begin({
        identity,
        screen: $('#screen'),
        onStage: (stage, d) => p.step(d?.label ?? stage, d?.total ? { done: d.done, total: d.total } : {}),
      });

      p.step('Waiting for the shell');
      await machine.run('true', { timeout: 120_000 });

      p.step('Applying your settings');
      await applyIdentity(identity);

      p.step(`Calving ${BASE_NAME}`);
      await Floes.saveSetup({ ...identity, password: undefined });
      await session.calveAs(BASE_NAME, {
        note: 'The factory machine.',
        onProgress: (ev) => p.step(ev.label ?? ev.phase, ev.total ? { done: ev.done, total: ev.total } : {
          note: ev.uploadedChunks != null ? `${ev.uploadedChunks} pieces uploaded` : '',
        }),
      });
      p.close();
      notify(`${BASE_NAME} is calved. It will always be here, exactly like this.`, { title: 'Done', tone: 'ok', ms: 8000 });
      paintRibbon();
      await workspace();
    } catch (e) {
      p.close();
      fail(e);
      go.disabled = false;
    }
  }

  app.replaceChildren(el('div', { class: 'gate' },
    el('div', { class: 'panel gate__card' },
      el('p', { class: 'eyebrow' }, 'First run'),
      el('h2', {}, 'Name your machine'),
      el('p', { class: 'muted' },
        `Iceberg will start a clean Alpine system, apply these, and calve the result as ` +
        `${BASE_NAME}. That floe is permanent: you can always come back to it, and ` +
        `nothing you do later can change it.`),
      el('div', { class: 'grid2' },
        el('label', { class: 'field' }, el('span', {}, 'Username'), f.username),
        el('label', { class: 'field' }, el('span', {}, 'Hostname'), f.hostname),
        el('label', { class: 'field' }, el('span', {}, 'Password'), f.password,
          el('p', { class: 'hint' }, 'Used inside the machine only. It is stored in the machine, like any Linux password, and your vault is private.')),
        el('label', { class: 'field' }, el('span', {}, 'Time zone'), f.timezone),
        el('label', { class: 'field' }, el('span', {}, 'Shell'), f.shell)),
      el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, go),
      el('p', { class: 'muted small' },
        'Roughly a minute. Most of it is the first download of the factory image, which ' +
        'your browser then caches.'))));
}

async function applyIdentity(id) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const steps = [
    `echo ${q(id.hostname)} > /etc/hostname`,
    `hostname ${q(id.hostname)}`,
    `sed -i "s/^127.0.0.1.*/127.0.0.1 localhost ${id.hostname}/" /etc/hosts || true`,
    id.shell === 'bash' ? 'command -v bash >/dev/null || true' : 'true',
    `adduser -D -s /bin/${id.shell === 'bash' ? 'bash' : 'ash'} ${q(id.username)} 2>/dev/null || true`,
    id.password ? `echo ${q(`${id.username}:${id.password}`)} | chpasswd 2>/dev/null || true` : 'true',
    id.password ? `echo ${q(`root:${id.password}`)} | chpasswd 2>/dev/null || true` : 'true',
    `ln -sf /usr/share/zoneinfo/${id.timezone} /etc/localtime 2>/dev/null || true`,
    `echo ${q(id.timezone)} > /etc/timezone`,
    `printf 'export PS1="\\\\h:\\\\w\\\\$ "\\nexport EDITOR=vi\\nexport TZ=%s\\n' ${q(id.timezone)} >> /etc/profile`,
    `mkdir -p /home/${id.username}/projects && chown -R ${id.username} /home/${id.username} 2>/dev/null || true`,
    `printf 'Calved by Iceberg.\\n' > /etc/motd`,
  ];
  for (const cmd of steps) {
    try { await machine.run(cmd, { timeout: 30_000 }); } catch { /* a machine without adduser is still a machine */ }
  }
}

/* ------------------------------------------------------------------ */
/* screen: the workspace                                               */
/* ------------------------------------------------------------------ */

let term = null, editor = null, tree = null, pane = 'terminal';

async function workspace({ bare = false } = {}) {
  const screen = el('div', { id: 'screen', class: 'screen', 'aria-hidden': 'true' });
  const termBox = el('section', { class: 'pane pane--terminal', dataset: { pane: 'terminal' } });
  const filesBox = el('aside', { class: 'pane pane--files', dataset: { pane: 'files' } });
  const editBox = el('section', { class: 'pane pane--editor', dataset: { pane: 'editor' } });

  const switcher = el('nav', { class: 'switch', role: 'tablist' },
    ['files', 'terminal', 'editor'].map((p) => el('button', {
      class: 'switch__btn', role: 'tab', dataset: { pane: p },
      'aria-selected': String(p === pane),
      onclick: () => showPane(p),
    }, p)));

  app.replaceChildren(el('div', { class: 'work' }, filesBox, termBox, editBox, screen, switcher));
  showPane(window.innerWidth < 900 ? 'terminal' : pane);
  paintRibbon();

  if (bare) return;

  if (!term) {
    term = new Terminal(machine);
    await term.mount(termBox);
  } else {
    termBox.append(...[...(term.term?.element?.parentElement?.children ?? [])]);
  }

  tree = new FileTree(machine.fs);
  tree.onOpen = (p) => { editor?.open(p); showPane('editor'); };
  await tree.mount(filesBox);

  editor = new Editor(machine.fs, {
    onRun: async (path) => {
      if (!path) return;
      showPane('terminal');
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      machine.send(`cd ${dir}\n`);
      await sleep(120);
      machine.send(guessRun(path) + '\n');
    },
  });
  await editor.mount(editBox);

  session.on('drift', (d) => tree?.markDrift(d));
  term.focus();
}

function guessRun(path) {
  if (path.endsWith('.rs')) return `rustc ${path} -o /tmp/a.out && /tmp/a.out`;
  if (path.endsWith('.py')) return `python3 ${path}`;
  if (path.endsWith('.js')) return `node ${path}`;
  if (path.endsWith('.sh')) return `sh ${path}`;
  return `cat ${path}`;
}

function showPane(p) {
  pane = p;
  document.querySelectorAll('.pane').forEach((n) => n.classList.toggle('pane--on', n.dataset.pane === p));
  document.querySelectorAll('.switch__btn').forEach((n) => n.setAttribute('aria-selected', String(n.dataset.pane === p)));
  if (p === 'terminal') term?.focus();
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function thawInto(floeId) {
  if (session.dirty && !(await confirmLeaveSession())) return;
  await workspace({ bare: true });
  const entry = Floes.byId(floeId);
  const p = progress({ title: `Thawing ${entry?.name ?? 'floe'}`, subtitle: 'Fetching only the pieces this machine needs' });
  try {
    await session.begin({
      floeId,
      screen: $('#screen'),
      onStage: (stage, d) => p.step(d?.label ?? stage, d?.total ? { done: d.done, total: d.total } : {}),
    });
    p.close();
    await workspace();
    notify(`${entry.name} is running. Nothing you do now touches it until you calve.`,
      { title: 'Thawed', tone: 'warm', ms: 7000 });
  } catch (e) {
    p.close();
    fail(e);
    shelf();
  }
}

async function calveFlow() {
  await session.measure();
  if (!session.dirty && session.floeId) {
    const anyway = await confirm({
      title: 'Nothing has changed',
      body: [`This session is identical to “${session.floeName}”. Calving it would make a copy under a new name.`],
      confirmLabel: 'Calve a copy anyway', cancelLabel: 'Never mind',
    });
    if (!anyway) return;
  }

  let warm = false;
  const res = await ask({
    title: 'Calve this session',
    body: [session.describeDrift(), 'The floe you thawed from stays exactly as it is.'],
    label: 'Name this floe',
    placeholder: 'Rust Dev + LLVM',
    value: session.floeName ? `${session.floeName} +` : '',
    confirmLabel: 'Calve',
    validate: (v) => Floes.checkName(v),
    extra: (panel) => {
      const chk = el('input', { type: 'checkbox' });
      const note = el('input', { type: 'text', placeholder: 'a line about what this is for (optional)' });
      panel.append(
        el('label', { class: 'field' }, el('span', {}, 'Note'), note),
        el('label', { class: 'check' }, chk,
          ' Also calve memory, so it resumes instantly with everything open'),
        el('p', { class: 'muted small' },
          `Adds roughly ${MACHINE.memoryMB} MB before compression, and ties the floe ` +
          'to this emulator version. Most floes do not need it.'));
      return { read: () => ({ warm: chk.checked, note: note.value }) };
    },
  });
  if (!res) return;

  const p = progress({ title: `Calving “${res.value}”`, subtitle: 'Reading the machine' });
  try {
    const out = await session.calveAs(res.value, {
      warm: res.warm, note: res.note,
      onProgress: (ev) => {
        const label = ev.label ?? ({
          reading: 'Reading the machine', uploading: 'Uploading new pieces',
          indexing: 'Writing the index', warm: 'Calving memory', committing: 'Sealing the floe',
        }[ev.phase] ?? ev.phase);
        p.step(label, ev.total
          ? { done: ev.done, total: ev.total }
          : { note: ev.uploadedChunks != null ? `${ev.uploadedChunks} new · ${ev.sharedChunks ?? 0} shared` : '' });
      },
    });
    p.close();
    const s = out.stats;
    notify(
      `${s.uploadedChunks} new ${s.uploadedChunks === 1 ? 'piece' : 'pieces'} uploaded, ` +
      `${s.sharedChunks} already in your vault. ${duration(s.ms)}.`,
      { title: `Calved — ${s.name}`, tone: 'ok', ms: 9000 });
    paintRibbon();
  } catch (e) {
    p.close();
    fail(e);
  }
}

async function confirmLeaveSession() {
  const answer = await choose({
    title: 'This session has drift',
    body: [session.describeDrift(), 'Leaving it means losing everything since the thaw.'],
    options: [
      { label: 'Calve it first', value: 'calve' },
      { label: 'Throw it away', value: 'discard', tone: 'danger' },
      { label: 'Stay here', value: null },
    ],
  });
  if (answer === 'calve') { await calveFlow(); return !session.dirty; }
  return answer === 'discard';
}

async function menu() {
  const running = !!machine.emulator;
  const action = await choose({
    title: 'Machine',
    body: running ? [session.label, `State: ${SAYS[machine.state]}.`] : ['No machine is running.'],
    options: [
      running && machine.asleep ? { label: 'Wake', value: 'wake' } : null,
      running && machine.awake ? { label: 'Sleep now', value: 'sleep', hint: 'Parks the processor; nothing is lost' } : null,
      running ? { label: 'Calve as a floe', value: 'calve' } : null,
      running ? { label: 'Melt the session', value: 'melt', tone: 'danger', hint: 'Back to the floe, drift discarded' } : null,
      { label: `Return to ${BASE_NAME}`, value: 'base', hint: 'Boot the factory machine' },
      { label: 'The shelf', value: 'shelf' },
      running ? { label: 'Scuttle', value: 'scuttle', tone: 'danger', hint: 'Shut the machine down' } : null,
      { label: 'Manual', value: 'docs' },
      { label: 'Sign out', value: 'signout' },
    ].filter(Boolean),
  });

  if (action === 'wake') await machine.wake();
  if (action === 'sleep') { machine.park('you asked'); await machine.deepen('you asked'); }
  if (action === 'calve') await calveFlow();
  if (action === 'docs') window.open('docs.html', '_blank', 'noopener');
  if (action === 'signout') await doSignOut();

  if (action === 'melt') {
    const ok = await confirm({
      title: 'Melt this session?',
      body: [
        session.describeDrift(),
        session.floeName
          ? `The machine comes back up from “${session.floeName}”, exactly as it was calved.`
          : 'There is no floe to come back to; the machine restarts from the factory image.',
      ],
      confirmLabel: 'Melt it', tone: 'danger',
    });
    if (ok) {
      const p = progress({ title: 'Melting', subtitle: 'Coming back up from the floe' });
      try {
        await workspace({ bare: true });
        await session.melt({ screen: $('#screen'), onStage: (s, d) => p.step(d?.label ?? s) });
        p.close();
        await workspace();
      } catch (e) { p.close(); fail(e); }
    }
  }

  if (action === 'base') {
    const b = Floes.base();
    if (!b) return notify(`${BASE_NAME} is not in this vault yet.`, { tone: 'bad' });
    if (session.dirty && !(await confirmLeaveSession())) return;
    await thawInto(b.id);
  }

  if (action === 'shelf') {
    if (session.dirty) {
      const ok = await confirm({
        title: 'Leave the machine running?',
        body: [session.describeDrift(), 'The session stays in this tab. It is not saved anywhere yet.'],
        confirmLabel: 'Go to the shelf', cancelLabel: 'Stay',
      });
      if (!ok) return;
    }
    await shelf();
  }

  if (action === 'scuttle') {
    if (session.dirty && !(await confirmLeaveSession())) return;
    await session.end();
    await shelf();
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

(async function start() {
  paintRibbon();
  if (!globalThis.crypto?.subtle) {
    return app.replaceChildren(el('div', { class: 'gate' }, el('div', { class: 'panel gate__card' },
      el('h2', {}, 'Insecure context'),
      el('p', { class: 'muted' },
        'Iceberg needs Web Crypto to address content by hash, and browsers withhold it ' +
        'outside https or http://localhost. Serve this page over https, or run ' +
        'python3 -m http.server and open http://localhost:8000.'))));
  }

  const user = await Auth.restore();
  if (!user) return gate();
  try { await afterSignIn(); }
  catch (e) { fail(e); gate({ reason: e.message }); }
})();

Auth.auth.on('account-changed', () => location.reload());
window.addEventListener('online', () => notify('Back online.', { tone: 'ok', ms: 3000 }));
window.addEventListener('offline', () => notify(
  'Offline. The machine keeps running — calving needs GitHub and will wait.',
  { title: 'No network', tone: 'warm', ms: 8000 }));
