/* ICEBERG — authentication.
 *
 * Two ways in, one interface out: a bearer token for api.github.com.
 *
 *   Vault key   a fine-grained personal access token the user creates. 100%
 *               static, nothing of ours in the loop. This is the default.
 *   Sign in     GitHub App + OAuth device flow through a stateless relay,
 *               because GitHub's token endpoints send no CORS headers and
 *               require a client secret. Optional; absent unless configured.
 *
 * The token lives in sessionStorage (dies with the tab). "Remember on this
 * device" wraps it with AES-GCM under a PBKDF2 key derived from a passphrase
 * the user types; the raw token never touches persistent storage.
 */

import { APP, OAUTH } from './config.js';
import { gh, GitHubError } from './github.js';
import { idb } from './idb.js';
import { subtle, toBase64, fromBase64, enc, dec, sleep, Emitter } from './util.js';

const SESSION_KEY = 'iceberg.key';
const VAULT_RECORD = 'auth.vault';
const PBKDF2_ROUNDS = 310_000;

export const auth = new Emitter();

export const state = {
  token: null,
  user: null,
  mode: null,          // 'key' | 'signin'
};

/* ---------- the permission contract, stated once ---------- */

export const PERMISSIONS = [
  {
    name: 'Administration',
    level: 'Read and write',
    why: `Create the ${APP.vaultRepo} repository once, as a private repository. Nothing else uses it.`,
  },
  {
    name: 'Contents',
    level: 'Read and write',
    why: 'Read and write floes, the keel and the index. This is the whole product.',
  },
  {
    name: 'Metadata',
    level: 'Read',
    why: 'Mandatory companion to the others. GitHub adds it for you.',
  },
];

export const NOT_REQUESTED = [
  'Actions', 'Workflows', 'Secrets', 'Environments', 'Packages',
  'Deployments', 'Pull requests', 'Issues', 'Webhooks',
  'any organisation permission', 'any other repository',
];

export function tokenCreationUrl() {
  const p = new URLSearchParams({
    name: 'Iceberg vault key',
    description: 'Iceberg — read and write my machine vault',
  });
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

/* ---------- shape checks that fail early and specifically ---------- */

export function inspectKey(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (/\s/.test(t)) return { ok: false, reason: 'That looks like it picked up a line break. Paste it again.' };
  if (t.startsWith('github_pat_')) return { ok: true, kind: 'fine-grained' };
  if (t.startsWith('ghp_')) return { ok: true, kind: 'classic', warn:
    'That is a classic token. It works, but it can reach every repository you own. ' +
    'A fine-grained token scoped to one repository is strictly safer.' };
  if (t.startsWith('ghu_') || t.startsWith('gho_')) return { ok: true, kind: 'oauth' };
  return { ok: false, reason: 'That does not look like a GitHub token. Fine-grained keys start with github_pat_.' };
}

/* ---------- entry ---------- */

export async function signInWithKey(raw, { remember = null } = {}) {
  const check = inspectKey(raw);
  if (!check.ok) throw new GitHubError(check.reason ?? 'Unusable key', { status: 0 });

  const token = String(raw).trim();
  gh.setToken(token);

  let user;
  try {
    user = await gh.viewer();
  } catch (e) {
    gh.setToken(null);
    if (e.auth) throw new GitHubError('GitHub rejected that key. Check it was copied whole and has not expired.', { status: 401 });
    throw e;
  }

  await adopt(token, user, 'key');
  if (remember) await rememberOnDevice(token, remember);
  return user;
}

async function adopt(token, user, mode) {
  const previous = sessionStorage.getItem('iceberg.login');
  state.token = token;
  state.user = user;
  state.mode = mode;
  sessionStorage.setItem(SESSION_KEY, token);
  sessionStorage.setItem('iceberg.login', user.login);
  sessionStorage.setItem('iceberg.mode', mode);
  gh.setToken(token);
  auth.emit('signin', user);
  if (previous && previous !== user.login) {
    // A different account must never inherit the previous one's view.
    auth.emit('account-changed', { from: previous, to: user.login });
  }
}

export async function restore() {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) return null;
  gh.setToken(token);
  try {
    const user = await gh.viewer();
    state.token = token;
    state.user = user;
    state.mode = sessionStorage.getItem('iceberg.mode') || 'key';
    auth.emit('signin', user);
    return user;
  } catch {
    signOut({ silent: true });
    return null;
  }
}

export function signOut({ silent = false } = {}) {
  state.token = null;
  state.user = null;
  state.mode = null;
  gh.setToken(null);
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem('iceberg.login');
  sessionStorage.removeItem('iceberg.mode');
  if (!silent) auth.emit('signout');
}

export const revocationUrl = 'https://github.com/settings/tokens?type=beta';

/* ---------- remember on this device (opt-in, passphrase-wrapped) ---------- */

async function deriveKey(passphrase, salt) {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function rememberOnDevice(token, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token)));
  await idb.set('meta', VAULT_RECORD, {
    v: 1, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct),
    login: state.user?.login ?? null, at: new Date().toISOString(),
  });
}

export async function hasRemembered() {
  return !!(await idb.get('meta', VAULT_RECORD));
}

export async function rememberedLogin() {
  return (await idb.get('meta', VAULT_RECORD))?.login ?? null;
}

export async function unlockRemembered(passphrase) {
  const rec = await idb.get('meta', VAULT_RECORD);
  if (!rec) throw new Error('Nothing is remembered on this device.');
  const key = await deriveKey(passphrase, fromBase64(rec.salt));
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(rec.iv) }, key, fromBase64(rec.ct));
  } catch {
    throw new Error('That passphrase does not open the stored key.');
  }
  return signInWithKey(dec.decode(plain));
}

export async function forgetDevice() {
  await idb.del('meta', VAULT_RECORD);
}

/* ---------- device flow (only when a relay is configured) ---------- */

export const signInAvailable = () => !!(OAUTH.RELAY_URL && OAUTH.CLIENT_ID);

export async function startDeviceFlow() {
  if (!signInAvailable()) throw new Error('Sign in with GitHub is not configured on this deployment.');
  const res = await fetch(`${OAUTH.RELAY_URL.replace(/\/$/, '')}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OAUTH.CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`The sign-in relay refused the request (${res.status}).`);
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: (data.interval ?? 5) * 1000,
    expiresIn: (data.expires_in ?? 900) * 1000,
  };
}

export async function pollDeviceFlow(flow, { signal, onTick } = {}) {
  const deadline = Date.now() + flow.expiresIn;
  let wait = flow.interval;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    await sleep(wait);
    onTick?.(Math.max(0, deadline - Date.now()));
    const res = await fetch(`${OAUTH.RELAY_URL.replace(/\/$/, '')}/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: OAUTH.CLIENT_ID, device_code: flow.deviceCode }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.access_token) {
      gh.setToken(data.access_token);
      const user = await gh.viewer();
      await adopt(data.access_token, user, 'signin');
      return user;
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { wait += 5000; continue; }
    if (data.error === 'expired_token') throw new Error('The code expired. Start again.');
    if (data.error === 'access_denied') throw new Error('Sign-in was declined on GitHub.');
    if (data.error) throw new Error(data.error_description || data.error);
  }
  throw new Error('The code expired. Start again.');
}
