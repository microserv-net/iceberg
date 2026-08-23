/* ICEBERG — utilities. No dependencies, no side effects on import. */

/* ---------- DOM ---------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;      // callers must pre-escape
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- bytes ---------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes) {
  // Chunked so a multi-megabyte chunk cannot blow the argument stack.
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

export function fromBase64(s) {
  const clean = s.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------- compression (native, no library) ---------- */

async function pipe(bytes, stream) {
  const rs = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(rs).arrayBuffer());
}

export const hasCompression = typeof CompressionStream !== 'undefined';

export async function deflate(bytes) {
  if (!hasCompression) return bytes;
  return pipe(bytes, new CompressionStream('deflate-raw'));
}

export async function inflate(bytes) {
  if (!hasCompression) return bytes;
  return pipe(bytes, new DecompressionStream('deflate-raw'));
}

/* ---------- hashing ---------- */

export function subtle() {
  if (!globalThis.crypto?.subtle) {
    const e = new Error(
      'Web Crypto is unavailable. Iceberg needs a secure context — https, or ' +
      'http://localhost. Opening the page from a file:// path will not work.'
    );
    e.name = 'InsecureContextError';
    throw e;
  }
  return globalThis.crypto.subtle;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

export async function sha256(bytes) {
  return hex(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

/* Non-cryptographic, used only where a collision costs a redundant upload. */
export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/* ---------- identifiers ---------- */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}

/* ---------- control flow ---------- */

export class Deferred {
  constructor() { this.promise = new Promise((res, rej) => { this.resolve = res; this.reject = rej; }); }
}

export async function pool(items, limit, worker, onProgress) {
  const queue = items.slice();
  let done = 0;
  const total = items.length;
  const results = new Array(total);
  const indexOf = new Map(items.map((it, i) => [it, i]));
  const runners = Array.from({ length: Math.min(limit, total) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const i = indexOf.get(item);
      results[i] = await worker(item, i);
      done++;
      onProgress?.(done, total);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function retry(fn, { tries = 4, base = 400, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await fn(attempt); }
    catch (err) {
      lastErr = err;
      if (err?.fatal || attempt === tries - 1) throw err;
      const wait = err.retryAfterMs ?? Math.round((base * 2 ** attempt) * (0.5 + Math.random()));
      onRetry?.(err, attempt, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ---------- formatting ---------- */

export function bytesHuman(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function ago(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;   if (m < 60) return `${Math.floor(m)} min ago`;
  const h = m / 60;   if (h < 24) return `${Math.floor(h)} h ago`;
  const d = h / 24;   if (d < 30) return `${Math.floor(d)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/* ---------- events ---------- */

export class Emitter {
  #map = new Map();
  on(name, fn) {
    if (!this.#map.has(name)) this.#map.set(name, new Set());
    this.#map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) { this.#map.get(name)?.delete(fn); }
  emit(name, detail) {
    for (const fn of this.#map.get(name) ?? []) {
      try { fn(detail); } catch (e) { console.error(`[${name}]`, e); }
    }
    for (const fn of this.#map.get('*') ?? []) {
      try { fn({ name, detail }); } catch (e) { console.error(e); }
    }
  }
}

/* ---------- paths ---------- */

export function normPath(p) {
  const parts = String(p).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

export function dirname(p) {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export const basename = (p) => normPath(p).split('/').pop() || '/';

export function isExcluded(path, list) {
  for (const pre of list) if (path === pre.slice(0, -1) || path.startsWith(pre)) return true;
  return false;
}
