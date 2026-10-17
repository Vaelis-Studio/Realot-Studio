# Realot — Client Distribution

This is the static Realot editor, runtime, player, and game exporter. It
does not include an Android SDK, Gradle, or an APK build server. Android APKs
are built by the external API server configured in the editor.

## Run the editor

Upload this folder to any static host that serves ES modules, JSON, WASM, and
the included vendor files. The included `_redirects` and `_headers` files configure Cloudflare Pages
(friendly `/editor` and `/play` routes, cache headers). For a local preview, use any static HTTP server, for
example:

```bash
python3 -m http.server 5000
```

Open `http://localhost:5000/` and choose **Open Editor**.

## Android APK export

The editor builds an HTML5 or PWA game ZIP in the browser, then sends that ZIP
to the external Android build API. In **Export → Android APK**, add the API
server URL and API key supplied by the server owner. The API endpoint must
accept:

```text
POST /api/v1/build?name=<url-encoded-game-title>
```

with the ZIP as the request body and the headers documented in
`project/editor/export/ANDROID_EXPORT_CONTRACT.md`.

The client package does not contain Android SDK files, Gradle files, Java
build scripts, or a local APK builder. The APK server is only needed while
creating the APK; the finished APK runs independently.

## Documentation and safety

- `docs/index.html` — quick start, scripting API, exporting (linked from the hub's Learn tab).
- `SECURITY.md` — **read before sharing projects:** game scripts are not sandboxed; set up a separate play origin.
- `file-association/` — how to get the Realot icon on `.rs` project files.
- `tests/e2e-play-origin.py` — browser test for the Play window and its origin isolation.
- `THIRD_PARTY_LICENSES.md` — licenses for bundled libraries. Exported games include their own copy.

## Folder map

- `project/runtime/` — the game engine shipped with games
- `project/editor/` — the development editor and HTML5/PWA exporter
- `project/player/` — the standalone player
- `project/vendor/` — required local Pixi, Hammer, Rapier, Monaco, JSZip, and
  other vendor files
- `css/`, `icons/`, and `js/` — the engine hub client
- `docs/` — documentation pages
- `sw.js` and `offline-manifest.json` — offline PWA support

## What is intentionally not included

This client distribution excludes the local Android SDK/Gradle tooling,
server-side APK builder, Node server, tests and verification utilities,
Replit configuration, Replit task/skill files, caches, workspace secrets, Git
metadata, temporary archives, and deployment-only server configuration.