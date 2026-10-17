# Offline PWA support

The Realot client precaches the editor, player, runtime, vendor files, and
local assets listed in `/offline-manifest.json` during service-worker
installation. The Android build API is not part of the offline cache because
it is only needed while creating an APK.

1. Serve the client over HTTP(S) and open `/` once while connected.
2. Wait for the first page to finish loading so the service worker can finish
   its precache.
3. Install the PWA from the browser. The editor, player, and local engine can
   then be relaunched without a network connection.

The service worker also handles the `/editor`, `/play`, and `/player` aliases
while offline, preserving the canonical document URL so relative ES-module
imports continue to work. Android APK creation still requires the configured
external API server.

## Cloudflare Pages

- Build command: `node scripts/build-offline-manifest.mjs` (regenerates
  `offline-manifest.json`). Output directory: the project root (`/`).
- Cloudflare serves clean URLs (`/index.html` -> `/`). The service worker
  answers those clean URLs directly and never redirects to a `.html` URL,
  which is what previously caused "too many redirects" on reload.
- After deploying, bump `CACHE_NAME` in `sw.js` only if you need to force every
  client to drop its old cache. Otherwise updates are picked up network-first.
