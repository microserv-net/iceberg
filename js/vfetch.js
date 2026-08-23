/* ICEBERG — the virtual origin.
 *
 * v86 loads 9p file contents lazily: it is given a base URL and asks for
 * `<baseurl><content-hash>` the first time the guest touches a file. That is
 * exactly the behaviour we want — a boot reads a few hundred files, not thirty
 * thousand — but the bytes live in an authenticated private repository, and the
 * emulator must not be handed a GitHub token to go and get them.
 *
 * So we give it an origin that does not exist. Requests to
 * `https://keel.iceberg.invalid/…` never reach the network: they are
 * answered here, from the keel, with the token staying on this side of the
 * boundary. The guest can neither see the handler nor reach past it.
 *
 * Both fetch and XMLHttpRequest are covered, because v86 has used each at
 * different times and the choice is not ours to make.
 *
 * A service worker would be the tidier version of this and would also survive a
 * reload without re-installing. It is not used because it must be served from
 * the site's own scope, needs its own token hand-off, and buys nothing a user
 * can perceive. If Pages ever serves this app under a path where a worker is
 * simpler, the handler signature below is the whole contract.
 */

export const VIRTUAL_ORIGIN = 'https://keel.iceberg.invalid';

let handler = null;
let installed = false;

/** handler: (path: string) => Promise<Uint8Array | null> */
export function setHandler(fn) { handler = fn; }

export function install() {
  if (installed) return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.startsWith(VIRTUAL_ORIGIN)) return nativeFetch(input, init);
    const bytes = await serve(url);
    if (!bytes) return new Response(null, { status: 404, statusText: 'Not in the keel' });
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
  };

  const XHR = window.XMLHttpRequest;
  class ShimXHR extends XHR {
    #virtual = null;
    open(method, url, ...rest) {
      if (typeof url === 'string' && url.startsWith(VIRTUAL_ORIGIN)) {
        this.#virtual = url;
        // Give the base class something harmless to hold; we never send it.
        return super.open(method, 'about:blank', ...rest);
      }
      this.#virtual = null;
      return super.open(method, url, ...rest);
    }
    send(body) {
      if (!this.#virtual) return super.send(body);
      const url = this.#virtual;
      queueMicrotask(async () => {
        let bytes = null, err = null;
        try { bytes = await serve(url); } catch (e) { err = e; }
        const ok = !!bytes && !err;
        define(this, 'readyState', 4);
        define(this, 'status', ok ? 200 : 404);
        define(this, 'statusText', ok ? 'OK' : 'Not in the keel');
        define(this, 'response', ok ? toResponseType(bytes, this.responseType) : null);
        if (this.responseType === '' || this.responseType === 'text') {
          define(this, 'responseText', ok ? binaryString(bytes) : '');
        }
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new ProgressEvent(ok ? 'load' : 'error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      });
    }
  }
  window.XMLHttpRequest = ShimXHR;
}

function define(obj, prop, value) {
  Object.defineProperty(obj, prop, { configurable: true, get: () => value });
}

function toResponseType(bytes, type) {
  if (type === 'arraybuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === 'blob') return new Blob([bytes]);
  return binaryString(bytes);
}

function binaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}

async function serve(url) {
  if (!handler) return null;
  const path = url.slice(VIRTUAL_ORIGIN.length).replace(/^\/+/, '');
  return handler(decodeURIComponent(path));
}
