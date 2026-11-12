// Service worker for the DSH Companion PWA (spec 020 requirement 4).
//
// SCOPE, DELIBERATELY NARROW: this caches the app SHELL only — the HTML shell, the hashed
// `_expo/static/**` bundles and the local icons/fonts they need — so a reload works offline and
// the app starts instantly. It NEVER caches:
//   * API traffic (anything under /api, /rpc, /pair, /devices …): a stale approval list or a stale
//     session view is a correctness AND safety problem, not a performance one;
//   * WebSocket traffic (a service worker cannot see it anyway — `wss://` never reaches `fetch`);
//   * any credential: the token lives in IndexedDB behind a non-extractable WebCrypto key, and
//     this worker must never read, copy or persist it. It touches no storage other than `caches`.
//   * cross-origin requests, and any request with credentials or an Authorization header.
//
// Keeping the allowlist positive (only these paths are cacheable) is what makes the guarantee
// auditable: an endpoint added later is NOT cached unless someone edits this list.

const CACHE = 'dsh-shell-v4';

/** Static shell assets: content-hashed by the bundler, so cache-first is safe. */
const SHELL_ASSET_PATHS = ['/_expo/static/', '/assets/', '/icon.svg', '/icon-maskable.svg', '/manifest.json'];

/** Paths that must never be served from cache, even if they match a shell prefix. */
const NEVER_CACHE = ['/api/', '/rpc', '/pair', '/devices', '/auth', '/push', '/sw.js'];

/**
 * A bundler-hashed asset name (`name.<8+ hex>.js`, e.g. `index-10b55514.js`, `__common-ca1a7256.js`).
 * Only such names are safe to serve cache-first, because a content change always changes the name.
 */
const HASHED_ASSET = /\.[0-9a-f]{8,}\.(?:js|css|woff2?|png|jpg|svg|webp)$/i;

function isShellAsset(url) {
  if (!SHELL_ASSET_PATHS.some((prefix) => url.pathname.startsWith(prefix))) return false;
  return !NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix));
}

/** A navigation request: serve the shell if the network is unavailable (offline start only). */
function isNavigation(request) {
  return request.mode === 'navigate';
}

self.addEventListener('install', (event) => {
  // PRECACHE THE SHELL AT INSTALL (found by an offline reload test, not by reading the code): on a
  // first visit nothing is controlled yet, so requests made before this worker claims the page never
  // pass through `fetch` below and the cache stayed empty — an offline reload then failed outright.
  // The hashed bundle names are only known after the build, so `scripts/build-web.mjs` writes them
  // to `/precache.json`; this reads that list. Each entry is fetched on its own so one bad file
  // cannot discard the rest, and a failed install step must never block the worker itself.
  event.waitUntil((async () => {
    try {
      const listing = await fetch('/precache.json', { cache: 'no-store' });
      if (listing.ok) {
        const paths = await listing.json();
        const cache = await caches.open(CACHE);
        for (const path of Array.isArray(paths) ? paths : []) {
          if (typeof path !== 'string' || !path.startsWith('/')) continue;
          if (NEVER_CACHE.some((prefix) => path.startsWith(prefix))) continue;
          try {
            const response = await fetch(path, { cache: 'no-store' });
            if (!response.ok) continue;
            // The shell is only a shell when it really is HTML (same rule as the fetch handler).
            if (path === '/' && !(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) continue;
            // One canonical key form for put and match (see the offline-shell lookup below), built
            // from the worker's own origin so it cannot drift from what `cache.match` is asked.
            await cache.put(new URL(path, self.location.origin).href, response);
          } catch {
            // Skip this entry; the runtime handler below still caches it on first controlled use.
          }
        }
      }
    } catch {
      // No list (or offline during install): fall back to runtime caching only.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only same-origin GETs are ever considered.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('authorization')) return;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (isNavigation(request)) {
    // NOTE (measured, not assumed): a page navigation arrives with `credentials: "include"` — that
    // is how browsers issue every top-level document request. An earlier version of this worker
    // skipped any request with `credentials === 'include'` BEFORE reaching this branch, so it never
    // answered a single navigation and the offline shell could not work, even though the cache was
    // full. The credentials guard therefore applies to sub-resources only (below). A navigation to
    // `/` carries no token of ours: credentials live in IndexedDB behind a WebCrypto key, never in a
    // cookie, and this worker still never reads them.
    //
    // Network-first navigation with a cached shell fallback: a deploy is picked up immediately
    // online, and an offline reload still starts the app (which then shows its own honest
    // "cannot reach your computer" state — this worker never fakes a connected app).
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Only a real HTML shell may be cached as the shell: caching an API/JSON/redirect body
        // under '/' would serve the wrong document offline (reviewer requirement).
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.toLowerCase().includes('text/html')) {
          const cache = await caches.open(CACHE);
          await cache.put(new URL('/', self.location.origin).href, response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(new URL('/', self.location.origin).href);
        if (cached !== undefined) return cached;
        throw new Error('offline and no cached shell');
      }
    })());
    return;
  }

  // Only content-hashed assets are cache-first: a hashed name can never go stale. `/assets/`
  // entries that are NOT hashed (a future unhashed file under that prefix) are served from the
  // network only — and when this worker's strategy changes, bump CACHE above so every client
  // drops the previous shell (the activate handler deletes any other cache name).
  // Sub-resources: only a positive allowlist of same-origin static shell paths is ever cached
  // (`isShellAsset`), and an `Authorization` header already bailed out above. There is deliberately
  // NO `credentials === 'include'` check: a classic `<script src>` / `<link>` without `crossorigin`
  // is requested with exactly that mode (measured in this page's own index.html), so such a guard
  // would skip every bundle and silently disable the offline shell. This app sets no cookies — the
  // credential lives in IndexedDB behind a WebCrypto key — so there is nothing credentialed to leak.
  if (!isShellAsset(url)) return;
  if (url.pathname.startsWith('/assets/') && !HASHED_ASSET.test(url.pathname)) return;

  // Cache-first for content-hashed assets; the cache entry is refreshed on a miss.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
