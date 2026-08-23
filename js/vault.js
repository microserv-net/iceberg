/* ICEBERG — the vault.
 *
 * One private repository per user. It is created once, repaired on every visit,
 * and is the only place the user's machine lives. There is no database here and
 * no database anywhere else either.
 *
 * Layout:
 *   .iceberg/vault.json     schema, client, creation time
 *   index.json               the floe index: names, ids, lineage, sizes
 *   floes/<id>.json       one manifest per floe
 *   keel/<aa>/<hash>      content-addressed chunk, deflate-raw
 *
 * Every write is one commit. Ref updates are compare-and-swap, so two devices
 * calving at the same moment produce two commits, never a lost one.
 */

import { APP, LIMITS } from './config.js';
import { gh, GitHubError } from './github.js';
import { enc, dec, toBase64, sleep, Emitter } from './util.js';

export const vault = new Emitter();

export const repo = {
  owner: null,
  name: APP.vaultRepo,
  branch: 'main',      // resolved from the repository, NOT assumed
  head: null,          // commit sha we believe is current
  tree: null,          // its root tree sha
  ready: false,
  private: null,
  sizeKB: null,
};

const path = (p) => p.replace(/^\/+/, '');

/* ------------------------------------------------------------------ */
/* provisioning                                                        */
/* ------------------------------------------------------------------ */

/**
 * Idempotent and self-repairing. Runs on every visit, decides on evidence
 * (is the marker file present?) rather than on history (did we just create it?).
 * A half-finished provision finishes on the next load instead of becoming
 * permanent.
 */
export async function ensureVault(login, { onStep } = {}) {
  repo.owner = login;
  const step = (s, detail) => { onStep?.(s, detail); vault.emit('provision', { step: s, detail }); };

  step('looking', `Looking for ${login}/${APP.vaultRepo}`);
  let r = await gh.maybe(`/repos/${login}/${APP.vaultRepo}`);

  if (!r) {
    step('creating', 'Creating your private vault');
    try {
      r = await gh.post('/user/repos', {
        name: APP.vaultRepo,
        private: true,
        auto_init: true,                 // never leave an empty repository behind
        has_issues: false,
        has_wiki: false,
        has_projects: false,
        has_downloads: false,
        description: 'My Iceberg machine. Private. Managed by the Iceberg web app.',
      });
    } catch (e) {
      if (e.status === 403) {
        e.message = 'The key cannot create repositories. It needs Administration: ' +
          'Read and write, and it must be scoped to all repositories on first use, ' +
          'because the vault does not exist yet.';
      }
      if (e.status === 422 && /already exists/i.test(e.body?.errors?.[0]?.message ?? '')) {
        r = await gh.get(`/repos/${login}/${APP.vaultRepo}`);
      } else throw e;
    }

    // Repository creation is not instantly consistent.
    for (let i = 0; i < 12 && r; i++) {
      const ref = await gh.getRef(login, APP.vaultRepo, `heads/${r.default_branch || 'main'}`);
      if (ref) break;
      await sleep(700 + i * 300);
    }
  }

  if (r.private === false) {
    // Adopting a public repo of the same name would put a machine image in the
    // open. Refuse, name it, and let the user decide.
    throw new GitHubError(
      `${login}/${APP.vaultRepo} exists but is public. Iceberg will not write a ` +
      `machine into a public repository. Make it private on GitHub, or rename it ` +
      `and let Iceberg create a fresh vault.`,
      { status: 0 }
    );
  }

  repo.private = true;
  repo.sizeKB = r.size ?? null;

  // Whatever this repository calls its default branch is what Iceberg writes to.
  // Accounts configured with `master`, or vaults made by hand, work unchanged.
  repo.branch = r.default_branch || 'main';

  if (repo.branch !== 'main') {
    step('branch', `Renaming the default branch from ${repo.branch} to main`);
    const renamed = await gh
      .post(`/repos/${login}/${APP.vaultRepo}/branches/${repo.branch}/rename`, { new_name: 'main' })
      .catch(() => null);
    // Cosmetic, not required. If it fails we keep using the existing name rather
    // than writing to a branch that is not there.
    if (renamed) repo.branch = 'main';
  }

  await refresh();

  const marker = await readJSON('.iceberg/vault.json');
  if (!marker) {
    step('seeding', 'Laying down the vault structure');
    await seed();
  } else if (marker.schema > APP.schema) {
    throw new GitHubError(
      `This vault was written by a newer Iceberg (vault schema ${marker.schema}, ` +
      `this build understands ${APP.schema}). Reload the site to pick up the newer ` +
      `client rather than risk writing a floe it cannot read.`,
      { status: 0 }
    );
  }

  repo.ready = true;
  step('ready', `${login}/${APP.vaultRepo}`);
  vault.emit('ready', { ...repo });
  return repo;
}

async function seed() {
  const readme = [
    '# Iceberg vault',
    '',
    'This repository is a computer.',
    '',
    'It holds the saved states — *floes* — of a machine that runs inside a',
    'web browser. Each floe is a commit. The files under `keel/` are',
    'content-addressed pieces of filesystem, shared between every floe that',
    'contains them, which is why adding a compiler to a saved machine costs the',
    'compiler and not the machine.',
    '',
    '**Do not hand-edit this repository.** Iceberg reads it as a data structure,',
    'not as source. If something here is broken, the app can rebuild the index',
    'from the floe manifests.',
    '',
    '- `index.json` — the floe index: names, lineage, sizes.',
    '- `floes/<id>.json` — one manifest per floe.',
    '- `keel/<aa>/<hash>` — deduplicated chunks, deflate-raw compressed.',
    '',
    'This repository is private and must stay private. It contains everything',
    'you have ever put on the machine.',
  ].join('\n');

  const vaultDoc = {
    schema: APP.schema,
    client: APP.client,
    created: new Date().toISOString(),
  };

  const index = {
    schema: APP.schema,
    updated: new Date().toISOString(),
    floes: [],
    setup: null,
  };

  await commit({
    message: 'iceberg: cut the vault',
    files: [
      { path: 'README.md', text: readme },
      { path: '.gitignore', text: '# Nothing here is ignored. Everything is deliberate.\n' },
      { path: '.iceberg/vault.json', text: JSON.stringify(vaultDoc, null, 2) },
      { path: 'index.json', text: JSON.stringify(index, null, 2) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

export async function refresh() {
  let ref = await gh.getRef(repo.owner, repo.name, `heads/${repo.branch}`);

  // The branch we expected is not there. Rather than failing every write with a
  // 422 forever, find out what the repository actually calls its default branch
  // and follow that. An account whose default is `master`, or a vault made by
  // hand, is then indistinguishable from any other.
  if (!ref) {
    const r = await gh.maybe(`/repos/${repo.owner}/${repo.name}`);
    const actual = r?.default_branch;
    if (actual && actual !== repo.branch) {
      ref = await gh.getRef(repo.owner, repo.name, `heads/${actual}`);
      if (ref) repo.branch = actual;
    }
  }

  if (!ref) {
    // No branch at all: an empty repository. The first commit will be a root
    // commit and will create the ref rather than update it.
    repo.head = null; repo.tree = null;
    return null;
  }
  repo.head = ref.object.sha;
  const c = await gh.getCommit(repo.owner, repo.name, repo.head);
  repo.tree = c.tree.sha;
  return repo.head;
}

/** True if the vault's branch has moved since we last looked — another device. */
export async function movedElsewhere() {
  const before = repo.head;
  const ref = await gh.getRef(repo.owner, repo.name, `heads/${repo.branch}`);
  return !!(ref && before && ref.object.sha !== before);
}

export async function readText(p) {
  try {
    const r = await gh.getContentRaw(repo.owner, repo.name, path(p), repo.branch);
    if (r.notModified) return undefined;         // caller keeps its cached copy
    return typeof r.data === 'string' ? r.data : dec.decode(r.data);
  } catch (e) {
    if (e.notFound) return null;
    throw e;
  }
}

export async function readJSON(p) {
  const t = await readText(p);
  if (t == null) return t;
  try { return JSON.parse(t); }
  catch { throw new GitHubError(`${p} in your vault is not readable JSON.`, { status: 0 }); }
}

/* ------------------------------------------------------------------ */
/* writing — one commit, compare-and-swap                              */
/* ------------------------------------------------------------------ */

const MODE_FILE = '100644';
const TREE_BATCH = 400;

/**
 * Commit a set of paths in exactly one commit.
 *   files:   [{ path, text }]           small text, uploaded as a blob here
 *   blobs:   [{ path, sha }]            blobs already uploaded (the keel)
 *   deletes: ['path', ...]              removed via a null sha entry
 *
 * Retries the ref update on a lost race by rebasing onto the new head. The
 * data being written is content-addressed and path-stable, so rebasing is
 * genuinely safe here — two devices writing different floes cannot conflict.
 */
export async function commit({ message, files = [], blobs = [], deletes = [], tries = 5 }) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const parent = repo.head;
    const baseTree = repo.tree;

    const entries = [];
    for (const f of files) {
      const sha = await gh.putBlob(repo.owner, repo.name, toBase64(enc.encode(f.text)));
      entries.push({ path: path(f.path), mode: MODE_FILE, type: 'blob', sha });
    }
    for (const b of blobs) entries.push({ path: path(b.path), mode: MODE_FILE, type: 'blob', sha: b.sha });
    for (const d of deletes) entries.push({ path: path(d), mode: MODE_FILE, type: 'blob', sha: null });

    // Chain batched trees so an enormous calve does not produce one enormous
    // request body.
    let treeSha = baseTree;
    for (let i = 0; i < entries.length; i += TREE_BATCH) {
      const slice = entries.slice(i, i + TREE_BATCH);
      const t = await gh.createTree(repo.owner, repo.name, slice, treeSha);
      treeSha = t.sha;
      await gh.breathe();
    }
    if (!entries.length && treeSha === baseTree) return { head: parent, unchanged: true };

    const c = await gh.createCommit(repo.owner, repo.name, {
      message, tree: treeSha, parents: parent ? [parent] : [],
    });
    if (!c?.sha) throw new GitHubError('GitHub accepted the commit but returned no id.', { status: 0 });

    try {
      const ref = `heads/${repo.branch}`;
      // An empty repository has no branch to move, so the first write creates
      // one. PATCHing a ref that does not exist is a 422, and retrying it is a
      // 422 five more times.
      if (parent) await gh.updateRef(repo.owner, repo.name, ref, c.sha, false);
      else await gh.createRef(repo.owner, repo.name, ref, c.sha);

      repo.head = c.sha;
      repo.tree = treeSha;
      vault.emit('commit', { sha: c.sha, message });
      return { head: c.sha, tree: treeSha };
    } catch (e) {
      // 422 covers three different situations and they need three answers.
      const why = [e.body?.message, ...(e.body?.errors ?? []).map((x) => x.message).filter(Boolean)]
        .filter(Boolean).join('; ') || String(e.message ?? '');
      console.error(`iceberg: ref update failed on heads/${repo.branch}`, e.status, e.body ?? e.message);

      // The commit may already be the tip — a retry after a response we never
      // saw. That is a success, not a conflict.
      const now = await gh.getRef(repo.owner, repo.name, `heads/${repo.branch}`).catch(() => null);
      if (now?.object?.sha === c.sha) {
        repo.head = c.sha; repo.tree = treeSha;
        vault.emit('commit', { sha: c.sha, message });
        return { head: c.sha, tree: treeSha };
      }
      const missing = /does not exist|Not Found/i.test(why);
      const exists = /already exists/i.test(why);
      const raced = e.status === 409 || /fast forward/i.test(why);

      if (!(missing || exists || raced) || attempt === tries - 1) {
        // Anything else is a real failure. Say so once instead of hammering it.
        if (e.status === 422) {
          e.message = `The vault refused the write on branch '${repo.branch}': ${why || 'unprocessable'}. ` +
            `Nothing was applied.`;
        }
        throw e;
      }

      vault.emit('raced', { attempt, why });
      await refresh();                       // re-read the branch and rebuild on it
      await sleep(300 * (attempt + 1) * (0.5 + Math.random()));
    }
  }
  throw new GitHubError('Could not write to the vault; another device kept winning the race.', { status: 0 });
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

export async function vaultSize() {
  const r = await gh.get(`/repos/${repo.owner}/${repo.name}`);
  repo.sizeKB = r.size;
  return r.size * 1024;
}

export function sizeVerdict(bytes) {
  if (bytes >= LIMITS.vaultRefuseBytes) return { level: 'refuse', message:
    'Your vault has passed 2 GB. GitHub starts to push back on repositories this ' +
    'size, and clones become painful. Forget a floe you no longer boot before calving another.' };
  if (bytes >= LIMITS.vaultWarnBytes) return { level: 'warn', message:
    'Your vault is over 800 MB. GitHub recommends staying under 1 GB. Forgetting ' +
    'an old floe releases its chunks the next time GitHub runs garbage collection.' };
  return { level: 'ok', message: null };
}
