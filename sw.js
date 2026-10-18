/**
 * sw.js
 * Offline-first service worker for the complete Realot Hub.
 *
 * HOSTING NOTE (Cloudflare Pages): Cloudflare serves "pretty URLs" and
 * 308-redirects /index.html -> / and /x/index.html -> /x/. This worker must
 * therefore NEVER redirect a clean URL back to its .html file (that created
 * an infinite redirect loop). Instead it answers clean URLs directly from
 * the cache/network using an internal "cache key" that points at the real file.
 *
 * Canonical public URLs:
 *   /                    -> /index.html
 *   /project/editor/     -> /project/editor/index.html
 *   /project/player/play -> /project/player/play.html
 */

const CACHE_NAME = "realot-offline-v24";
const MANIFEST_URL = "/offline-manifest.json";

// Pages that must exist in the cache for the app to be installable/offline.
const CRITICAL = [
  "/index.html",
  "/manifest.webmanifest",
  "/project/editor/index.html",
  "/project/player/play.html",
];

// Friendly aliases -> canonical clean URL (these are real redirects, but they
// point at URLs Cloudflare serves directly, so no loop is possible).
const ALIASES = {
  "/editor": "/project/editor/",
  "/editor/": "/project/editor/",
  "/project/editor": "/project/editor/",
  "/play": "/project/player/play",
  "/play/": "/project/player/play",
  "/player": "/project/player/play",
  "/player/": "/project/player/play",
  "/project/player": "/project/player/play",
  "/project/player/": "/project/player/play",
};

/** Map any request path to the file path we store in the cache. */
function toCachePath(pathname) {
  if (pathname === "/") return "/index.html";
  if (pathname.endsWith("/")) return pathname + "index.html";
  if (pathname === "/project/player/play") return "/project/player/play.html";
  if (pathname === "/docs") return "/docs/index.html";
  return pathname;
}

function keyFor(pathname) {
  return new Request(new URL(pathname, self.location.origin).href);
}

/**
 * Responses that followed a redirect (response.redirected) are rejected by the
 * browser when used to answer a navigation. Re-wrap them as clean responses.
 */
async function clean(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function cacheOne(cache, url) {
  const response = await fetch(new Request(url, { cache: "reload" }));
  if (!response.ok) throw new Error(url + " -> HTTP " + response.status);
  await cache.put(keyFor(toCachePath(url)), await clean(response));
}

async function precacheEverything() {
  const cache = await caches.open(CACHE_NAME);

  let files = [];
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) files = list;
    }
  } catch (_) { /* fall back to critical files only */ }

  // 1) Critical shell: if any of these fail, installation fails (retry later).
  await Promise.all(CRITICAL.map((u) => cacheOne(cache, u)));

  // 2) Everything else is best-effort. One missing/oversized file must never
  //    stop the PWA from installing (that was making installability flaky).
  const SKIP = /\.(?:d\.ts|map)$|\/(?:LICENSE|README\.md|ThirdPartyNotices\.txt)$|\.nls\.(?:de|es|fr|it|ja|ko|ru|zh-cn|zh-tw)\.js$|\/basic-languages\/(?!javascript|typescript|html|css|json|markdown)/;
  const rest = Array.from(new Set(files)).filter(
    (u) => !CRITICAL.includes(u) && u !== "/sw.js" && !SKIP.test(u),
  );
  for (let i = 0; i < rest.length; i += 8) {
    await Promise.all(
      rest.slice(i, i + 8).map((u) =>
        cacheOne(cache, u).catch((e) =>
          console.warn("[Realot] skipped precache:", u, e.message),
        ),
      ),
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheEverything().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Drop EVERY other cache (any old name, any old engine version) so
            // a stale file from an earlier build can never mix with new code.
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Let the browser handle the worker script itself.
  if (url.pathname === "/sw.js") return;

  const isNav = request.mode === "navigate";

  // Aliases: redirect to the canonical clean URL (never to a .html URL).
  if (isNav && ALIASES[url.pathname]) {
    const target = new URL(ALIASES[url.pathname] + url.search + url.hash, self.location.origin);
    event.respondWith(Response.redirect(target.href, 302));
    return;
  }

  event.respondWith(handle(request, url, isNav));
});

async function handle(request, url, isNav) {
  const cache = await caches.open(CACHE_NAME);
  const cachePath = toCachePath(url.pathname);
  const key = keyFor(cachePath);

  const pathname = url.pathname.toLowerCase();

  // Big third-party / static files (Monaco, Pixi, Rapier + wasm, fonts,
  // images, icons) never change between deploys of the same cache version,
  // so serve them straight from the cache. Re-downloading ~20 MB of vendor
  // code on every load is what made the engine feel slow.
  const isCode = /\.(?:html?|js|mjs|css|json|webmanifest)$/.test(pathname);
  const isStatic =
    /\/vendor\//.test(pathname) ||
    (!isCode && /\/(?:fonts|icons|assets)\//.test(pathname)) ||
    /\.(?:wasm|woff2?|ttf|png|jpe?g|webp|avif|gif|svg|ico|mp3|ogg|opus|wav)$/.test(pathname);

  const networkFirst = !isStatic && (
    isNav ||
    /\.(?:html?|js|mjs|css|json|webmanifest)$/.test(pathname)
  );

  if (networkFirst) {
    try {
      // Navigations keep default redirect handling so Cloudflare's own
      // canonical redirects (e.g. /x/index.html -> /x/) still work.
      // Default cache mode: honours "Cache-Control: no-cache", i.e. a cheap
      // conditional request (304, no body) instead of a full re-download.
      const network = await fetch(request);

      if (network.type === "opaqueredirect") return network;
      if (network.ok) {
        const copy = await clean(network.clone());
        await cache.put(key, copy);
      }
      return network.redirected ? await clean(network) : network;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (isNav) {
        const fallback = await cache.match(keyFor("/index.html"));
        if (fallback) return fallback;
      }
      throw error;
    }
  }

  const cached = await cache.match(key);
  if (cached) return cached;
  const network = await fetch(request);
  if (network.ok) await cache.put(key, await clean(network.clone()));
  return network;
}
