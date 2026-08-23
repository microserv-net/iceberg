/* ICEBERG — the optional sign-in relay.
 *
 * The only piece of Iceberg that is not a static file, and you may simply not
 * deploy it. It exists because GitHub's OAuth endpoints
 * (github.com/login/device/code and .../oauth/access_token) send no CORS headers
 * and require a client_secret. A browser physically cannot call them and a
 * static site cannot hold a secret. That is GitHub's server refusing the
 * browser's preflight; it is not something to engineer around.
 *
 * This adds the secret, adds CORS headers, and passes the response through
 * verbatim. It stores nothing, logs nothing, and has no state of any kind.
 *
 * Deploy to Cloudflare Workers (or Deno Deploy with trivial edits) and set:
 *   CLIENT_ID       your GitHub App's client id
 *   CLIENT_SECRET   its secret
 *   ALLOWED_ORIGIN  the exact origin of your Pages site
 *
 * Then set OAUTH.RELAY_URL and OAUTH.CLIENT_ID in js/config.js. Leave them
 * blank and the sign-in option never appears in the interface.
 */

const ROUTES = {
  '/device/code': 'https://github.com/login/device/code',
  '/device/token': 'https://github.com/login/oauth/access_token',
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });

    const url = new URL(request.url);
    const target = ROUTES[url.pathname];
    if (!target) return new Response('Not found', { status: 404, headers: cors });

    // Refuse to be a general-purpose proxy for someone else's site.
    if (origin !== '*' && request.headers.get('origin') && request.headers.get('origin') !== origin) {
      return new Response('Forbidden origin', { status: 403, headers: cors });
    }

    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }

    const params = new URLSearchParams();
    params.set('client_id', env.CLIENT_ID);
    params.set('client_secret', env.CLIENT_SECRET);

    if (url.pathname === '/device/code') {
      // No scopes: a GitHub App's permissions are fixed at installation, which
      // is precisely why a GitHub App is used here rather than an OAuth App.
    } else {
      if (typeof body.device_code !== 'string' || body.device_code.length > 256) {
        return new Response('Bad device_code', { status: 400, headers: cors });
      }
      params.set('device_code', body.device_code);
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    }

    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
    });

    // Passed through unchanged. Nothing is read, kept, or rewritten.
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
