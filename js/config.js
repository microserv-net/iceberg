/* ICEBERG — configuration.
 * Everything tunable lives here. No secrets. This file is public by definition.
 */

export const APP = {
  name: 'Iceberg',
  version: '1.0.0',
  schema: 1,                       // vault layout version
  client: 'iceberg-web/1.0.0',
  vaultRepo: 'iceberg-vault',     // per-user PRIVATE repository name
  siteRepo: 'iceberg-web',
};

/* Optional. Leave RELAY_URL blank and "Sign in with GitHub" never appears;
 * the vault key (fine-grained PAT) path is fully static and needs nothing. */
export const OAUTH = {
  RELAY_URL: '',
  CLIENT_ID: '',
};

/* Where the public, immutable base images live. These are served by the SITE
 * repository over GitHub Pages — CORS-clean, CDN-cached, and never copied into
 * a user's vault unless they explicitly seal one in. */
export const IMAGES = {
  baseUrl: new URL('../images/', import.meta.url).href,
  default: 'alpine-3.21-x86-r1',
};

/* Content-defined chunking. See ARCHITECTURE.md §5.
 * Gear-hash boundaries, so an insertion re-chunks only its own neighbourhood. */
export const KEEL = {
  minChunk: 256 * 1024,
  avgChunk: 1024 * 1024,           // mask width 20 bits
  maxChunk: 4 * 1024 * 1024,
  mask: (1 << 20) - 1,
  compress: true,                  // deflate-raw before upload
  uploadConcurrency: 4,            // GitHub secondary-limit friendly
  downloadConcurrency: 6,
};

/* Machine defaults. memory is the guest's RAM; it is also, almost exactly, the
 * size of a warm floe, so it is deliberately conservative. */
export const MACHINE = {
  memoryMB: 512,
  vgaMemoryMB: 8,
  cpuCores: 1,
  wasmPath: new URL('../vendor/v86.wasm', import.meta.url).href,
  libPath: new URL('../vendor/libv86.js', import.meta.url).href,
  /* Awash → Awash (run loop parked) → Submerged (image written, emulator torn down) */
  awashAfterMs: 45_000,
  submergedAfterMs: 8 * 60_000,
  /* Mobile browsers evict background tabs aggressively; go to submerged on hide. */
  submergedOnHide: true,
};

export const LIMITS = {
  stateNameMax: 48,
  stateNameRe: /^[A-Za-z0-9][A-Za-z0-9 ._+#()-]{0,47}$/,
  maxFloes: 64,
  /* A single guest file larger than this is refused at calve time with a
   * named reason rather than silently dropped. GitHub blob ceiling is 100 MB;
   * we stop far short so one file can never wedge a calve. */
  maxFileBytes: 48 * 1024 * 1024,
  /* Advisory ceiling on total vault size. GitHub's own soft limit is 5 GB with
   * a strong recommendation to stay under 1 GB. */
  vaultWarnBytes: 800 * 1024 * 1024,
  vaultRefuseBytes: 2 * 1024 * 1024 * 1024,
  /* Paths never carried into a floe — volatile, enormous, or meaningless
   * once the machine is thawed somewhere else. */
  excluded: [
    '/proc/', '/sys/', '/dev/', '/run/', '/tmp/',
    '/var/cache/apk/', '/var/tmp/', '/var/log/',
  ],
};

/* The vocabulary, in one place, so the interface cannot drift from itself. */
export const WORDS = {
  floe: 'floe',
  floes: 'floes',
  thaw: 'Thaw',
  calve: 'Calve',
  melt: 'Melt',
  scuttle: 'Scuttle',
  drift: 'drift',
  vault: 'vault',
  keel: 'keel',
  awash: 'Awash',
  submerged: 'Submerged',
};

export const BASE_NAME = 'BASE';
